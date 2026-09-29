import OpenAI from 'openai';
import { getProviderDefaultHeaders } from './anthropicHeaders';
import { REASONING_EFFORT_LEVELS } from '../../constants';

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
      .map((model) => {
        // Effort levels the model says it takes (Settings → Model → Effort
        // offers exactly these): GitHub Copilot lists them; OpenRouter lists
        // `reasoning` among a model's supported parameters. Other providers
        // say nothing, and get their provider-wide levels (MODEL_PROVIDERS).
        const efforts =
          (model as any).capabilities?.supports?.reasoning_effort ??
          ((model as any).supported_parameters?.includes?.('reasoning') ? REASONING_EFFORT_LEVELS : undefined);
        return Array.isArray(efforts) && efforts.length ? { id: model.id, reasoningEfforts: efforts as string[] } : { id: model.id };
      });
  } catch (error: any) {
    console.error('Error fetching models:', error);
    // No HTTP status means the request never got an answer (server down,
    // wrong base URL, offline) — "Invalid API Key" would send an Ollama user
    // hunting for a key they don't have.
    if (error instanceof OpenAI.APIConnectionError) {
      throw new Error(`Could not reach ${baseURL} — is the server running?`);
    }
    throw new Error('Invalid API Key');
  }
}
