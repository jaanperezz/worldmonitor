/**
 * JARVIS Voice endpoint — no premium gate, personal use.
 *
 * POST /api/jarvis-voice
 * Body: { query: string, history?: {role,content}[] }
 *
 * Returns text/event-stream SSE:
 *   data: {"delta":"..."}
 *   data: {"done":true}
 *   data: {"error":"..."}
 */

export const config = { runtime: 'edge', regions: ['iad1', 'lhr1', 'fra1'] };

// @ts-expect-error — JS module
import { getCorsHeaders } from './_cors.js';

const MAX_QUERY_LEN = 600;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

const SYSTEM_PROMPT = `You are JARVIS, a sharp personal AI assistant for Jan — a developer, trader, and entrepreneur based in Barcelona.
You speak concisely and directly. No filler. No disclaimers. No "Great question!".
When asked about markets, trading or finance, be precise with numbers.
When asked to summarize, be brutally brief.
Always respond in the same language the user writes in.`;

function sse(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export default async function handler(req: Request): Promise<Response> {
  const cors = getCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: cors });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return new Response(sse({ error: 'GROQ_API_KEY not configured' }), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', ...cors },
    });
  }

  let body: { query?: unknown; history?: unknown[] };
  try {
    body = await req.json();
  } catch {
    return new Response(sse({ error: 'Invalid JSON' }), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', ...cors },
    });
  }

  const query = typeof body.query === 'string' ? body.query.slice(0, MAX_QUERY_LEN).trim() : '';
  if (!query) {
    return new Response(sse({ error: 'Empty query' }), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', ...cors },
    });
  }

  const rawHistory = Array.isArray(body.history) ? body.history : [];
  const history = rawHistory
    .filter((m): m is { role: string; content: string } =>
      typeof m === 'object' && m !== null &&
      (m as Record<string, unknown>).role === 'user' || (m as Record<string, unknown>).role === 'assistant'
    )
    .slice(-10)
    .map(m => ({ role: m.role as 'user' | 'assistant', content: String(m.content).slice(0, 800) }));

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: query },
  ];

  const upstream = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages,
      stream: true,
      max_tokens: 512,
      temperature: 0.7,
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const errText = await upstream.text().catch(() => 'upstream error');
    return new Response(sse({ error: errText }), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', ...cors },
    });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const reader = upstream.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const raw = line.slice(6).trim();
            if (raw === '[DONE]') {
              controller.enqueue(enc.encode(sse({ done: true })));
              continue;
            }
            try {
              const chunk = JSON.parse(raw);
              const delta = chunk.choices?.[0]?.delta?.content;
              if (delta) controller.enqueue(enc.encode(sse({ delta })));
            } catch { /* skip malformed */ }
          }
        }
        controller.enqueue(enc.encode(sse({ done: true })));
      } catch (e) {
        controller.enqueue(enc.encode(sse({ error: String(e) })));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
      ...cors,
    },
  });
}
