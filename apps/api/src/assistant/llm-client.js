import { z } from 'zod';
import { HttpError } from '../http-error.js';

const call = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), type: z.literal('function'),
  function: z.object({ name: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/), arguments: z.string().max(8000) }) });
// Native Gemini continuation data stays inside one agent turn. It is never
// stored in the conversation transcript or returned to the browser.
export const geminiParts = z.array(z.object({ text: z.string().max(16000).optional(), thought: z.boolean().optional(),
  thoughtSignature: z.string().max(32000).optional(), functionCall: z.object({ name: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/),
    args: z.record(z.string(), z.unknown()), id: z.string().min(1).max(256).optional() }).optional()
}).refine(part => part.text !== undefined || part.functionCall !== undefined)).min(1).max(8);
export const modelMessage = z.object({ role: z.literal('assistant'), content: z.string().max(2000).nullable(),
  tool_calls: z.array(call).max(1).optional(), geminiParts: geminiParts.optional() });

export async function limitedJson(response) {
  if (!response.body) throw new HttpError(502, 'AI_INVALID_RESPONSE');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > 131072) throw new HttpError(502, 'AI_INVALID_RESPONSE'); chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { throw new HttpError(502, 'AI_INVALID_RESPONSE'); }
  finally { await reader.cancel().catch(() => {}); }
}

// A single fixed OpenAI endpoint. Model output cannot select an endpoint,
// credential, URL or request header. Automated tests inject this adapter.
export function createOpenAIModel(config, { fetchImpl = globalThis.fetch } = {}) {
  return async ({ messages, tools, signal }) => {
    if (!config.OPENAI_API_KEY) throw new HttpError(503, 'ASSISTANT_UNAVAILABLE');
    let response;
    try {
      response = await fetchImpl('https://api.openai.com/v1/chat/completions', {
        method: 'POST', headers: { Authorization: 'Bearer ' + config.OPENAI_API_KEY, 'Content-Type': 'application/json' },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
        body: JSON.stringify({ model: config.OPENAI_MODEL || 'gpt-5.4-mini', messages, tools,
          parallel_tool_calls: false, max_completion_tokens: 1600, store: false })
      });
    } catch { throw new HttpError(503, 'AI_UNAVAILABLE'); }
    if (!response.ok) { await response.body?.cancel(); throw new HttpError(503, response.status === 429 ? 'AI_BUSY' : 'AI_UNAVAILABLE'); }
    const data = await limitedJson(response), choice = data.choices?.[0];
    if (choice?.finish_reason === 'length') throw new HttpError(502, 'AI_RESPONSE_LIMIT');
    const parsed = modelMessage.safeParse(choice?.message);
    if (!parsed.success || (!parsed.data.tool_calls?.length && !parsed.data.content?.trim())) throw new HttpError(502, 'AI_INVALID_RESPONSE');
    return parsed.data;
  };
}
