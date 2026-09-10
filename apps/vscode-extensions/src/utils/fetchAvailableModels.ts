import OpenAI from 'openai';
import { getProviderDefaultHeaders } from './anthropicHeaders';

// Model catalogs (OpenAI, Gemini, and router/aggregator providers like
// OpenRouter, Requesty, NVIDIA) mix chat-completion models in with
// embedding, TTS, image, moderation, and rerank models. None of those
// support /chat/completions, so leaving them in lets auto-select (and
// manual selection) land on a model that 404s or 400s at chat time.
const NON_CHAT_MODEL_PATTERN =
  /embed|rerank|moderation|whisper|tts|audio|speech|dall-?e|imagen|image-generation|veo|aqa|clip|stable-diffusion/i;

function isChatModel(id: string): boolean {
  return !NON_CHAT_MODEL_PATTERN.test(id);
}

export async function fetchAvailableModels(baseURL: string, apiKey: string) {
  try {
    const openai = new OpenAI({
      apiKey,
      baseURL,
      defaultHeaders: getProviderDefaultHeaders(baseURL, apiKey),
    });

    const response = await openai.models.list();
    return response.data
      .filter((model) => isChatModel(model.id))
      .map((model) => ({id: model.id}));
  } catch (error: any) {
    console.error('Error fetching models:', error);
    throw new Error('Invalid API Key');
  }
}
