import { randomUUID } from 'node:crypto';
import { HttpError } from '../http-error.js';
import { geminiParts, limitedJson, modelMessage } from './llm-client.js';

export const defaultGeminiModel = 'gemini-3.1-flash-lite';
export function geminiInput(messages) {
  const contents = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      const previous = messages[index - 1];
      const call = previous?.tool_calls?.find(value => value.id === message.tool_call_id);
      const native = previous?.geminiParts?.find(part => part.functionCall)?.functionCall;
      if (!call || !native || call.function.name !== native.name) throw new HttpError(502, 'AI_INVALID_RESPONSE');
      contents.push({ role: 'user', parts: [{ functionResponse: { name: native.name,
        ...(native.id ? { id: native.id } : {}), response: JSON.parse(message.content) } }] });
    } else if (message.role === 'assistant' && message.geminiParts) {
      // Return the original model parts, including opaque thought signatures.
      contents.push({ role: 'model', parts: geminiParts.parse(message.geminiParts) });
    } else contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] });
  }
  return { systemInstruction: { parts: messages.filter(message => message.role === 'system').map(message => ({ text: message.content })) }, contents };
}

export function createGeminiModel(config, { fetchImpl = globalThis.fetch } = {}) {
  return async ({ messages, tools, signal }) => {
    if (!config.GEMINI_API_KEY) throw new HttpError(503, 'ASSISTANT_UNAVAILABLE');
    const model = config.GEMINI_MODEL || defaultGeminiModel;
    if (!/^gemini-[a-z0-9][a-z0-9._-]{0,93}$/.test(model)) throw new HttpError(503, 'ASSISTANT_UNAVAILABLE');
    const input = geminiInput(messages);
    let response;
    try {
      response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST', headers: { 'x-goog-api-key': config.GEMINI_API_KEY, 'Content-Type': 'application/json' },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
        body: JSON.stringify({ ...input,
          tools: [{ functionDeclarations: tools.map(({ function: tool }) => ({ name: tool.name, description: tool.description,
            parametersJsonSchema: tool.parameters })) }],
          toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
          generationConfig: { candidateCount: 1, maxOutputTokens: 1600,
            ...(model === defaultGeminiModel ? { thinkingConfig: { thinkingLevel: 'minimal' } } : {}) } })
      });
    } catch { throw new HttpError(503, 'AI_UNAVAILABLE'); }
    if (!response.ok) {
      await response.body?.cancel();
      const error = new HttpError(503, response.status === 429 ? 'AI_BUSY' : 'AI_UNAVAILABLE');
      if (response.status === 429) {
        const wait = Number(response.headers.get('retry-after')); error.retryAfter = Number.isInteger(wait) && wait > 0 ? Math.min(wait, 86400) : 60;
      }
      throw error;
    }
    const data = await limitedJson(response), candidate = data.candidates?.[0];
    if (candidate?.finishReason === 'MAX_TOKENS') throw new HttpError(502, 'AI_RESPONSE_LIMIT');
    if (candidate?.finishReason !== 'STOP' || candidate.content?.role !== 'model') throw new HttpError(502, 'AI_INVALID_RESPONSE');
    const parsedParts = geminiParts.safeParse(candidate.content.parts);
    if (!parsedParts.success) throw new HttpError(502, 'AI_INVALID_RESPONSE');
    const parts = parsedParts.data, calls = parts.filter(part => part.functionCall);
    const answer = modelMessage.safeParse({ role: 'assistant', geminiParts: parts,
      content: parts.filter(part => !part.thought && part.text !== undefined).map(part => part.text).join('') || null,
      ...(calls.length ? { tool_calls: calls.map(({ functionCall: call }) => ({ id: 'call_' + randomUUID(), type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.args) } })) } : {}) });
    if (!answer.success || (!answer.data.tool_calls?.length && !answer.data.content?.trim())) throw new HttpError(502, 'AI_INVALID_RESPONSE');
    return answer.data;
  };
}
