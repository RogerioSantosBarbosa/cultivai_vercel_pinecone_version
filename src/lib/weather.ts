/**
 * Resumo de clima em UMA linha (economiza tokens do Groq: 12K TPM no Llama 70B).
 * - Chama a OpenWeather direto (o código antigo fazia fetch HTTP para a própria Vercel,
 *   dobrando cold start e falhando com Deployment Protection).
 * - Cache em memória de 10 min por cidade (free tier: 60 chamadas/min).
 * - Timeout de 3s: clima é opcional, nunca deve derrubar o chat.
 */
type Cached = { at: number; value: string };
const cache = new Map<string, Cached>();
const TTL_MS = 10 * 60 * 1000;

export async function getWeatherSummary(cidade?: string | null): Promise<string | null> {
    const apiKey = process.env.OPENWEATHER_API_KEY;
    if (!apiKey || !cidade) return null;

    const key = cidade.trim().toLowerCase();
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

    try {
        const url = new URL('https://api.openweathermap.org/data/2.5/weather');
        // ",BR" evita resolver "Bela Vista" para outro país
        url.searchParams.set('q', `${cidade.trim()},BR`);
        url.searchParams.set('appid', apiKey);
        url.searchParams.set('units', 'metric');
        url.searchParams.set('lang', 'pt_br');

        const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) return null;
        const d = await res.json();

        const partes = [
            d.weather?.[0]?.description ?? 'sem descrição',
            `${Math.round(d.main?.temp)}°C (sensação ${Math.round(d.main?.feels_like)}°C)`,
            `umidade ${d.main?.humidity}%`,
            `vento ${d.wind?.speed} m/s`,
        ];
        if (d.rain?.['1h']) partes.push(`chuva ${d.rain['1h']} mm/h`);

        const value = partes.join(', ');
        if (cache.size > 200) cache.clear();
        cache.set(key, { at: Date.now(), value });
        return value;
    } catch {
        return null;
    }
}