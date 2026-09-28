import fs from 'node:fs';
import path from 'node:path';
import { GoogleGenAI } from '@google/genai';
import { extractText } from 'unpdf';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const FOLDER_PATH = process.argv[2] || './docs-embrapa';
const STATE_FILE = '.ingest-state.json';
const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 100;

// Validação de variáveis de ambiente
const host = process.env.PINECONE_INDEX_HOST?.replace(/^https?:\/\//, '');
const pineconeApiKey = process.env.PINECONE_API_KEY;
const namespace = process.env.PINECONE_NAMESPACE || 'embrapa';
const geminiApiKey = process.env.GEMINI_API_KEY;

if (!host || !pineconeApiKey || !geminiApiKey) {
    console.error('❌ Erro: PINECONE_INDEX_HOST, PINECONE_API_KEY e GEMINI_API_KEY são obrigatórios no .env.local');
    process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: geminiApiKey });

// Leitura do estado de progresso para retomada automática
let state = { processedFiles: [] };
if (fs.existsSync(STATE_FILE)) {
    try {
        state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    } catch {
        state = { processedFiles: [] };
    }
}

function chunkText(text, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
    const chunks = [];
    let start = 0;
    while (start < text.length) {
        const end = start + size;
        const chunk = text.slice(start, end).trim();
        if (chunk) chunks.push(chunk);
        start += size - overlap;
    }
    return chunks;
}

// Util de retry (backoff simples) para lidar com falhas temporárias (ex: Rate Limit 429)
async function withRetry(fn, label, tentativas = 5) {
    for (let i = 0; i < tentativas; i++) {
        try {
            return await fn();
        } catch (e) {
            const espera = Math.min(30000, 1000 * 2 ** i); // Máximo de 30s de espera
            console.warn(`  ⚠️ ${label} falhou (tentativa ${i + 1}/${tentativas}): ${e.message}. Aguardando ${espera / 1000}s...`);
            await new Promise((r) => setTimeout(r, espera));
        }
    }
    throw new Error(`${label}: esgotou as tentativas. Rode o script de novo depois — o progresso por arquivo foi salvo.`);
}

// Função de embedding agora envelopada no withRetry e com taskType adicionado
async function getEmbedding(text) {
    return withRetry(async () => {
        const res = await ai.models.embedContent({
            model: 'gemini-embedding-001',
            contents: text,
            config: { 
                outputDimensionality: 768, 
                taskType: 'RETRIEVAL_DOCUMENT' // Especifica que é para RAG
            },
        });
        return res.embedding?.values || res.embeddings?.[0]?.values || res.values;
    }, 'Gemini embedContent');
}

// Função de upsert envelopada no withRetry
async function upsertPinecone(vectors) {
    return withRetry(async () => {
        const res = await fetch(`https://${host}/vectors/upsert`, {
            method: 'POST',
            headers: {
                'Api-Key': pineconeApiKey,
                'Content-Type': 'application/json',
                'X-Pinecone-Api-Version': '2025-04',
            },
            body: JSON.stringify({
                vectors,
                namespace,
            }),
        });

        if (!res.ok) {
            const err = await res.text();
            throw new Error(`Pinecone Upsert Error ${res.status}: ${err}`);
        }
    }, 'Pinecone upsert');
}

async function main() {
    if (!fs.existsSync(FOLDER_PATH)) {
        console.error(`❌ Pasta "${FOLDER_PATH}" não encontrada.`);
        process.exit(1);
    }

    const files = fs.readdirSync(FOLDER_PATH).filter((f) => f.toLowerCase().endsWith('.pdf'));
    console.log(`\n📚 Encontrados ${files.length} arquivo(s) PDF em "${FOLDER_PATH}"`);

    for (let i = 0; i < files.length; i++) {
        const fileName = files[i];
        if (state.processedFiles.includes(fileName)) {
            console.log(`⏩ [${i + 1}/${files.length}] Ignorando "${fileName}" (já processado).`);
            continue;
        }

        console.log(`\n📄 [${i + 1}/${files.length}] Processando: "${fileName}"...`);
        const filePath = path.join(FOLDER_PATH, fileName);
        const buffer = fs.readFileSync(filePath);

        try {
            const pdfData = new Uint8Array(buffer);
            const { text } = await extractText(pdfData);

            const fullText = Array.isArray(text) ? text.join('\n') : String(text || '');
            if (!fullText.trim()) {
                console.warn(`⚠️ Aviso: Nenhum texto extraído de "${fileName}". Ppulando...`);
                state.processedFiles.push(fileName);
                fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
                continue;
            }

            const chunks = chunkText(fullText);
            console.log(`   └ Extraídos ${chunks.length} trecho(s). Gerando embeddings...`);

            const vectors = [];
            for (let j = 0; j < chunks.length; j++) {
                const chunk = chunks[j];
                const vector = await getEmbedding(chunk);

                const id = `${fileName.replace(/[^a-zA-Z0-9]/g, '_')}_chunk_${j}`;
                vectors.push({
                    id,
                    values: vector,
                    metadata: {
                        fonte: fileName,
                        texto: chunk,
                    },
                });

                // Pequena pausa para respeitar cotas de requisições por minuto (mantida do código original)
                await new Promise((r) => setTimeout(r, 200));
            }

            // Envia para o Pinecone em lotes de 100
            for (let k = 0; k < vectors.length; k += 100) {
                const batch = vectors.slice(k, k + 100);
                await upsertPinecone(batch);
            }

            console.log(`   ✅ Enviado(s) ${vectors.length} vetor(es) ao Pinecone!`);
            state.processedFiles.push(fileName);
            fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
        } catch (err) {
            console.error(`❌ Erro ao processar "${fileName}":`, err.message);
            console.log('   O progresso até aqui foi salvo. Corrija e execute novamente.');
            break;
        }
    }

    console.log('\n🎉 Processo de ingestão concluído!');
}

main();