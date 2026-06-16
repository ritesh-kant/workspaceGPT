import { EmbeddingProvider } from './EmbeddingProvider';
import { LocalEmbeddingProvider } from './LocalEmbeddingProvider';
import { GeminiEmbeddingProvider } from './GeminiEmbeddingProvider';
import { EmbeddingProviderId } from '../types/embeddingManifest';

export interface MakeProviderConfig {
  provider: EmbeddingProviderId;
  /** Required for gemini. */
  apiKey?: string;
  /** Required for local — the initialized Xenova pipeline. */
  extractor?: any;
}

export function makeEmbeddingProvider(cfg: MakeProviderConfig): EmbeddingProvider {
  if (cfg.provider === 'gemini') {
    if (!cfg.apiKey) throw new Error('Gemini embedding selected but no API key configured.');
    return new GeminiEmbeddingProvider(cfg.apiKey);
  }
  if (!cfg.extractor) throw new Error('Local embedding selected but model not initialized.');
  return new LocalEmbeddingProvider(cfg.extractor);
}
