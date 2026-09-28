import { NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';
import dbConnect from '@/lib/mongodb';
import ChatMessage from '@/models/ChatMessage';
import { getUserIdFromToken } from '@/lib/auth';

const GROQ_MODELS = (process.env.GROQ_MODELS || 'openai/gpt-oss-20b,llama-3.1-8b-instant')
    .split(',').map(s => s.trim()).filter(Boolean);

const LIMITE_POR_MINUTO = Number(process.env.RATE_LIMIT_PER_MINUTE ?? 4);
const LIMITE_POR_DIA = Number(process.env.RATE_LIMIT_PER_DAY ?? 30);

export async function POST(req: Request) {
    try {
        // 👇 NOVO: exige sessão válida
        const userId = await getUserIdFromToken();
        if (!userId) {
            return NextResponse.json({ success: false, message: 'Não autenticado.' }, { status: 401 });
        }

        const body = await req.json();
        const userPrompt = body.question || body.message || body.prompt || body.text ||
            (body.messages && body.messages[body.messages.length - 1]?.content);

        if (!userPrompt || typeof userPrompt !== 'string' || userPrompt.length > 1000) {
            return NextResponse.json({ success: false, message: 'Mensagem inválida (1 a 1000 caracteres).' }, { status: 400 });
        }

        await dbConnect();

        // 👇 NOVO: rate limit contando mensagens já salvas no Mongo (sem infra extra)
        const agora = Date.now();
        const [ultimoMinuto, ultimas24h] = await Promise.all([
            ChatMessage.countDocuments({ userId, sender: 'user', createdAt: { $gte: new Date(agora - 60_000) } }),
            ChatMessage.countDocuments({ userId, sender: 'user', createdAt: { $gte: new Date(agora - 86_400_000) } }),
        ]);
        if (ultimoMinuto >= LIMITE_POR_MINUTO || ultimas24h >= LIMITE_POR_DIA) {
            return NextResponse.json(
                { success: false, message: 'Limite de perguntas atingido. Tente novamente em alguns minutos.' },
                { status: 429, headers: { 'Retry-After': '60' } },
            );
        }

        // 👇 NOVO: salva a pergunta do usuário
        await ChatMessage.create({ userId, text: userPrompt, sender: 'user' });

        const geminiKey = process.env.GEMINI_API_KEY;
        const pineconeKey = process.env.PINECONE_API_KEY;
        const pineconeHost = (process.env.PINECONE_INDEX_HOST || '').replace(/^https?:\/\//, '');
        const pineconeNamespace = process.env.PINECONE_NAMESPACE || 'embrapa';
        const groqKey = process.env.GROQ_API_KEY;

        if (!geminiKey || !pineconeKey || !pineconeHost || !groqKey) {
            return NextResponse.json({ success: false, message: 'Configuração de servidor incompleta.' }, { status: 500 });
        }

        console.log('🧠 1/3 - Gerando embedding com Gemini...');
        const ai = new GoogleGenAI({ apiKey: geminiKey });
        const embedRes = await ai.models.embedContent({
            model: 'gemini-embedding-001',
            contents: userPrompt,
            config: { outputDimensionality: 768, taskType: 'RETRIEVAL_QUERY' },
        });
        const queryVector = embedRes.embeddings?.[0]?.values;
        if (!Array.isArray(queryVector) || queryVector.length !== 768) {
            throw new Error('Falha ao gerar vetor de busca no Gemini.');
        }

        console.log('🔍 2/3 - Consultando Pinecone...');
        let contextText = '';
        const fontes: string[] = [];
        try {
            const pineconeRes = await fetch(`https://${pineconeHost}/query`, {
                method: 'POST',
                headers: {
                    'Api-Key': pineconeKey,
                    'Content-Type': 'application/json',
                    'X-Pinecone-Api-Version': '2025-04',
                },
                body: JSON.stringify({ vector: queryVector, topK: 3, namespace: pineconeNamespace, includeMetadata: true }),
            });
            if (pineconeRes.ok) {
                const matches = (await pineconeRes.json()).matches || [];
                console.log(`✅ Pinecone respondeu com ${matches.length} matches.`);
                for (const match of matches) {
                    const trecho = match.metadata?.texto;
                    const fonte = match.metadata?.fonte;
                    if (typeof trecho === 'string' && trecho.trim()) {
                        contextText += `[${fonte ?? 'Embrapa'}] ${trecho}\n\n`;
                    }
                    if (typeof fonte === 'string' && !fontes.includes(fonte)) fontes.push(fonte);
                }
            } else {
                console.warn('⚠️ Erro do Pinecone:', await pineconeRes.text());
            }
        } catch (pErr) {
            console.warn('⚠️ Falha de rede ao consultar Pinecone:', pErr);
        }

        const systemPrompt = `Você é o CultivAI, um assistente agronômico especialista.
Responda com base primariamente nas informações da Embrapa fornecidas no contexto abaixo.
Se o contexto estiver vazio ou irrelevante, diga isso ao produtor antes de dar uma orientação geral.

CONTEXTO DA EMBRAPA:
${contextText || 'Nenhum trecho específico encontrado no banco de dados.'}`;

        console.log('🤖 3/3 - Enviando requisição para a Groq...');
        let answer = '';
        let lastErr = '';
        for (const model of GROQ_MODELS) {
            const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: userPrompt },
                    ],
                    temperature: 0.3,
                }),
            });
            if (groqRes.ok) {
                answer = (await groqRes.json()).choices?.[0]?.message?.content || '';
                console.log(`🎉 Sucesso com ${model}.`);
                break;
            }
            lastErr = await groqRes.text();
            console.warn(`⚠️ ${model} falhou (${groqRes.status}):`, lastErr);
            if (groqRes.status !== 429) break;
        }

        if (!answer) {
            return NextResponse.json({ success: false, message: `Erro na API Groq: ${lastErr || 'sem resposta'}` }, { status: 502 });
        }

        // 👇 NOVO: salva a resposta do bot
        await ChatMessage.create({ userId, text: answer, sender: 'bot' });

        return NextResponse.json({ success: true, parsedData: { tipo: 'resposta', resposta: answer }, fontes });

    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Erro interno no servidor.';
        console.error('❌ Erro crítico capturado na rota /api/llm:', errorMessage);
        return NextResponse.json({ success: false, message: errorMessage }, { status: 500 });
    }
}