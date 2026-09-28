import { GoogleGenAI } from '@google/genai';

/**
 * RAG 100% free tier, executado dentro da própria função da Vercel:
 *   pergunta -> Gemini (embedding 768d) -> Pinecone (top-K) -> Groq (Llama) -> JSON
 * Sem SDK do Pinecone/Groq: só fetch (menos dependências, bundle menor, cold start menor).
 */

export class UpstreamError extends Error {
    constructor(
        public service: 'gemini' | 'pinecone' | 'groq',
        public status: number,
        public retryAfter?: number,
    ) {
        super(`${service} respondeu ${status}`);
        this.name = 'UpstreamError';
    }
}

function requireEnv(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Variável de ambiente ${name} não definida`);
    return v;
}

/* ------------------------------------------------------------------ */
/* 1) Embedding — gemini-embedding-001 (text-embedding-004 foi         */
/*    desativado em 14/01/2026). O padrão é 3072 dims: FORÇAMOS 768    */
/*    para casar com o índice do Pinecone.                              */
/* ------------------------------------------------------------------ */
export const EMBEDDING_MODEL = 'gemini-embedding-001';
export const EMBEDDING_DIMS = 768;

let genai: GoogleGenAI | null = null;
function gemini(): GoogleGenAI {
    return (genai ??= new GoogleGenAI({ apiKey: requireEnv('GEMINI_API_KEY') }));
}

/** Com dimensão != 3072 o Gemini NÃO normaliza o vetor; normalizamos aqui. */
export function normalize(v: number[]): number[] {
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
}

function withTimeout<T>(p: Promise<T>, ms: number, service: UpstreamError['service']): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new UpstreamError(service, 504)), ms);
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export async function embedQuery(text: string): Promise<number[]> {
    try {
        const res = await withTimeout(
            gemini().models.embedContent({
                model: EMBEDDING_MODEL,
                contents: text,
                config: { taskType: 'RETRIEVAL_QUERY', outputDimensionality: EMBEDDING_DIMS },
            }),
            8000,
            'gemini',
        );
        const values = res.embeddings?.[0]?.values;
        if (!values?.length) throw new UpstreamError('gemini', 502);
        return normalize(values);
    } catch (e) {
        if (e instanceof UpstreamError) throw e;
        throw new UpstreamError('gemini', (e as { status?: number }).status ?? 502);
    }
}

/* ------------------------------------------------------------------ */
/* 2) Busca vetorial — Pinecone REST                                   */
/* ------------------------------------------------------------------ */
export type Trecho = { texto: string; fonte: string; pagina?: number; score: number };

export async function searchKnowledge(vector: number[], topK = 3): Promise<Trecho[]> {
    const host = requireEnv('PINECONE_INDEX_HOST'); // ex.: cultivai-xxxx.svc.aped-xxxx.pinecone.io (sem https://)
    let res: Response;
    try {
        res = await fetch(`https://${host}/query`, {
            method: 'POST',
            headers: {
                'Api-Key': requireEnv('PINECONE_API_KEY'),
                'Content-Type': 'application/json',
                'X-Pinecone-Api-Version': '2025-04',
            },
            body: JSON.stringify({
                vector,
                topK,
                includeMetadata: true,
                namespace: process.env.PINECONE_NAMESPACE ?? 'embrapa',
            }),
            signal: AbortSignal.timeout(5000),
        });
    } catch {
        throw new UpstreamError('pinecone', 504);
    }
    if (!res.ok) throw new UpstreamError('pinecone', res.status);

    const data = (await res.json()) as {
        matches?: { score: number; metadata?: Record<string, unknown> }[];
    };
    // Calibre RAG_MIN_SCORE olhando os scores reais das suas perguntas (cosseno)
    const minScore = Number(process.env.RAG_MIN_SCORE ?? 0.5);

    return (data.matches ?? [])
        .filter((m) => m.score >= minScore && typeof m.metadata?.text === 'string')
        .map((m) => ({
            texto: String(m.metadata!.text),
            fonte: String(m.metadata!.fonte ?? 'Embrapa'),
            pagina: typeof m.metadata!.pagina === 'number' ? m.metadata!.pagina : undefined,
            score: m.score,
        }));
}

/* ------------------------------------------------------------------ */
/* 3) LLM — Groq (API compatível com OpenAI)                           */
/*    A cota do Groq é POR MODELO: se o 70B der 429 (12K TPM / 100K    */
/*    TPD no free), caímos para o próximo modelo da lista.             */
/* ------------------------------------------------------------------ */
export type ChatMsg = { role: 'system' | 'user' | 'assistant'; content: string };

const DEFAULT_MODELS = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];

export async function chatJson(messages: ChatMsg[]): Promise<string> {
    const fromEnv = (process.env.GROQ_MODELS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    const chain = fromEnv.length ? fromEnv : DEFAULT_MODELS;

    let last: UpstreamError = new UpstreamError('groq', 502);

    for (const model of chain) {
        let res: Response;
        try {
            res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${requireEnv('GROQ_API_KEY')}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model,
                    messages,
                    temperature: 0.3,
                    max_tokens: 600, // entra na conta do TPM; não exagere
                    response_format: { type: 'json_object' }, // o prompt precisa conter a palavra "JSON"
                }),
                signal: AbortSignal.timeout(15_000),
            });
        } catch {
            last = new UpstreamError('groq', 504);
            continue;
        }

        if (res.ok) {
            const data = await res.json();
            const content = data.choices?.[0]?.message?.content;
            if (typeof content === 'string' && content.trim()) return content;
            last = new UpstreamError('groq', 502);
            continue;
        }

        last = new UpstreamError('groq', res.status, Number(res.headers.get('retry-after')) || undefined);
        if (res.status === 429 || res.status >= 500) continue; // tenta o próximo modelo
        break; // 400/401/403: trocar de modelo não resolve
    }
    throw last;
}