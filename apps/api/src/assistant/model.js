import { createGeminiModel } from './gemini-client.js';
import { createOpenAIModel } from './llm-client.js';

// Explicit selection only: no provider fallback or unexpected paid request.
export function providerKey(config) {
  return config.AI_PROVIDER === 'openai' ? config.OPENAI_API_KEY : config.GEMINI_API_KEY;
}
export function createLanguageModel(config, options) {
  return config.AI_PROVIDER === 'openai' ? createOpenAIModel(config, options) : createGeminiModel(config, options);
}
