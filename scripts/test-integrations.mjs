import { GoogleGenAI } from '@google/genai';

async function testIntegrations() {
    console.log('\n--- 1. Testando Gemini Embeddings ---');
    try {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) throw new Error('GEMINI_API_KEY ausente no .env.local');

        const ai = new GoogleGenAI({ apiKey });
        const res = await ai.models.embedContent({
            model: 'gemini-embedding-001',
            contents: 'teste de embedding para RAG agronômico',
            config: { outputDimensionality: 768 },
        });

        const vec = res.embedding?.values || res.embeddings?.[0]?.values || res.values;

        if (vec && vec.length === 768) {
            console.log('✅ Gemini Embeddings OK! Vetor gerado com exatas 768 dimensões.');
        } else {
            console.error('❌ Resposta do Gemini sem vetor de 768d.');
        }
    } catch (err) {
        console.error('❌ Gemini falhou:', err.message);
    }

    console.log('\n--- 2. Testando Pinecone (REST) ---');
    try {
        const host = process.env.PINECONE_INDEX_HOST?.replace(/^https?:\/\//, '');
        const apiKey = process.env.PINECONE_API_KEY;
        const namespace = process.env.PINECONE_NAMESPACE || 'embrapa';

        if (!host || !apiKey) {
            throw new Error('PINECONE_INDEX_HOST ou PINECONE_API_KEY ausentes no .env.local');
        }

        const fakeVector = new Array(768).fill(0.01);

        const qRes = await fetch(`https://${host}/query`, {
            method: 'POST',
            headers: {
                'Api-Key': apiKey,
                'Content-Type': 'application/json',
                'X-Pinecone-Api-Version': '2025-04',
            },
            body: JSON.stringify({
                vector: fakeVector,
                topK: 1,
                namespace,
            }),
        });

        if (qRes.ok) {
            console.log('✅ Pinecone OK! Conexão REST e chave validadas com sucesso.');
        } else {
            const errText = await qRes.text();
            console.error(`❌ Pinecone erro HTTP ${qRes.status}:`, errText);
        }
    } catch (err) {
        console.error('❌ Pinecone falhou:', err.message);
    }

    console.log('\n--- 3. Consultando modelos disponíveis na sua chave Groq ---');
    const groqKey = process.env.GROQ_API_KEY;

    if (!groqKey) {
        console.error('❌ GROQ_API_KEY ausente no .env.local');
        return;
    }

    try {
        const modelsRes = await fetch('https://api.groq.com/openai/v1/models', {
            headers: { Authorization: `Bearer ${groqKey}` },
        });

        if (!modelsRes.ok) {
            const errBody = await modelsRes.text();
            console.error(`❌ Erro ao listar modelos do Groq HTTP ${modelsRes.status}: ${errBody}`);
            return;
        }

        const modelsData = await modelsRes.json();
        const availableModels = modelsData.data?.map((m) => m.id) || [];
        console.log('📋 Modelos ativos na sua chave Groq:', availableModels);

        if (availableModels.length === 0) {
            console.error('❌ Nenhum modelo ativo foi encontrado para esta chave.');
            return;
        }

        // Tenta testar o primeiro modelo da lista retornada pela própria Groq
        const modelToTest = availableModels[0];
        console.log(`\nTestando geração com o modelo retornado: "${modelToTest}"...`);

        const gRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${groqKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: modelToTest,
                messages: [{ role: 'user', content: 'Responda apenas o JSON: {"status": "ok"}' }],
                response_format: { type: 'json_object' },
            }),
        });

        if (gRes.ok) {
            const data = await gRes.json();
            console.log(`✅ Groq OK com o modelo "${modelToTest}"! Resposta:`, data.choices[0]?.message?.content);
            console.log(`\n👉 Dica: Atualize a variável GROQ_MODELS no seu .env.local com: ${availableModels.join(',')}`);
        } else {
            const errText = await gRes.text();
            console.error(`❌ Groq erro HTTP ${gRes.status}:`, errText);
        }
    } catch (err) {
        console.error('❌ Erro de conexão com o Groq:', err.message);
    }
}

testIntegrations();