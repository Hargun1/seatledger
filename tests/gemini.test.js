import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiModel, defaultGeminiModel } from '../apps/api/src/assistant/gemini-client.js';
import { createLanguageModel, providerKey } from '../apps/api/src/assistant/model.js';
import { readConfig } from '../apps/api/src/config.js';
import { runAgent } from '../apps/api/src/assistant/agent.js';
import { initialContext, toolDefinitions } from '../apps/api/src/assistant/tools.js';

const config = { GEMINI_API_KEY: 'private-gemini-canary' };
const native = parts => ({ candidates: [{ finishReason: 'STOP', content: { role: 'model', parts } }] });
const input = () => ({ messages: [{ role: 'system', content: 'Internal instructions' }, { role: 'user', content: 'Find comedy' }], tools: toolDefinitions });

test('Gemini native adapter uses a fixed endpoint, header-only key and bounded tool schemas', async () => {
  let request;
  const model = createGeminiModel(config, { fetchImpl: async (url, options) => {
    request = { url, ...options }; return Response.json(native([{ text: 'Which city?' }]));
  } });
  assert.equal((await model(input())).content, 'Which city?');
  assert.equal(request.url, `https://generativelanguage.googleapis.com/v1beta/models/${defaultGeminiModel}:generateContent`);
  assert.equal(request.headers['x-goog-api-key'], config.GEMINI_API_KEY); assert.ok(!request.url.includes(config.GEMINI_API_KEY));
  const body = JSON.parse(request.body); assert.ok(!request.body.includes(config.GEMINI_API_KEY));
  assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: 'Find comedy' }] }]);
  assert.equal(body.systemInstruction.parts[0].text, 'Internal instructions');
  assert.equal(body.tools[0].functionDeclarations.length, 7);
  assert.deepEqual(body.tools[0].functionDeclarations[0].parametersJsonSchema, toolDefinitions[0].function.parameters);
  assert.equal(body.generationConfig.maxOutputTokens, 1600); assert.equal(body.generationConfig.candidateCount, 1);
  assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'minimal');
});
test('Gemini tool continuation preserves opaque signatures and call IDs without exposing thoughts to the UI', async () => {
  const requests = [], parts = [{ text: 'PRIVATE_THOUGHT', thought: true, thoughtSignature: 'signed-thinking' },
    { functionCall: { id: 'native-call', name: 'clarifyPreferences', args: { field: 'budget' } }, thoughtSignature: 'signed-function' }];
  const model = createGeminiModel(config, { fetchImpl: async (_, options) => {
    const request = JSON.parse(options.body); requests.push(request);
    return Response.json(requests.length === 1 ? native(parts) : native([{ text: 'PRIVATE_MODEL_TEXT' }]));
  } });
  const result = await runAgent({ pool: {}, state: initialContext(), history: [], message: 'Two seats under 1500', model });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].contents.at(-2), { role: 'model', parts });
  const response = requests[1].contents.at(-1).parts[0].functionResponse;
  assert.equal(response.name, 'clarifyPreferences'); assert.equal(response.id, 'native-call'); assert.match(response.response.question, /per ticket/);
  assert.match(result.text, /per ticket/); assert.ok(!JSON.stringify(result).includes('PRIVATE_'));
  assert.ok(!JSON.stringify(result).includes('signed-function'));
});
test('Gemini quota, network and upstream errors are sanitized without automatic provider retries', async () => {
  let requests = 0;
  const model = createLanguageModel({ ...config, OPENAI_API_KEY: 'must-never-be-used' }, { fetchImpl: async url => {
    requests++; assert.ok(url.startsWith('https://generativelanguage.googleapis.com/'));
    return new Response('PRIVATE_UPSTREAM_BODY', { status: 429, headers: { 'retry-after': '120' } });
  } });
  await assert.rejects(model(input()), error => error.code === 'AI_BUSY' && error.retryAfter === 120 && !error.message.includes('PRIVATE'));
  assert.equal(requests, 1);
  const failed = createGeminiModel(config, { fetchImpl: async () => { throw new Error('PRIVATE_NETWORK_ERROR'); } });
  await assert.rejects(failed(input()), error => error.code === 'AI_UNAVAILABLE' && !error.message.includes('PRIVATE'));
});
test('Gemini rejects blocked, malformed, oversized, multi-call and truncated responses before executing tools', async () => {
  const fc = { functionCall: { name: 'clarifyPreferences', args: { field: 'city' } } };
  const responses = [Response.json({ candidates: [] }), Response.json({ candidates: [{ finishReason: 'SAFETY' }] }),
    Response.json({ candidates: [{ finishReason: 'MAX_TOKENS' }] }), Response.json(native([fc, fc])),
    Response.json(native([{ functionCall: { name: 'arbitraryCode', args: 'not-an-object' } }])),
    Response.json(native([{ text: 'private', thought: true }])), new Response('x'.repeat(140000))];
  for (const response of responses) {
    const model = createGeminiModel(config, { fetchImpl: async () => response });
    await assert.rejects(model(input()), error => ['AI_INVALID_RESPONSE','AI_RESPONSE_LIMIT'].includes(error.code));
  }
});
test('Gemini requires its own key, blocks endpoint injection and never falls back to an OpenAI credential', async () => {
  let calls = 0; const fetchImpl = async () => { calls++; throw new Error('unexpected request'); };
  await assert.rejects(createLanguageModel({ OPENAI_API_KEY: 'unused-openai-key' }, { fetchImpl })(input()), error => error.code === 'ASSISTANT_UNAVAILABLE');
  await assert.rejects(createGeminiModel({ ...config, GEMINI_MODEL: 'gemini-model/../../other' }, { fetchImpl })(input()), error => error.code === 'ASSISTANT_UNAVAILABLE');
  assert.equal(calls, 0); assert.equal(providerKey({ ...config, OPENAI_API_KEY: 'unused' }), config.GEMINI_API_KEY);
  assert.equal(providerKey({ ...config, AI_PROVIDER: 'openai', OPENAI_API_KEY: 'explicit' }), 'explicit');
  const env = { DATABASE_URL: 'postgresql://localhost/demo', AUTH_SECRET: 'a'.repeat(64) };
  assert.equal(readConfig(env).AI_PROVIDER, 'gemini'); assert.equal(readConfig(env).GEMINI_MODEL, defaultGeminiModel);
  assert.equal(readConfig({ ...env, GEMINI_API_KEY: '' }).GEMINI_API_KEY, undefined);
  assert.throws(() => readConfig({ ...env, AI_PROVIDER: 'arbitrary' }));
});
