import { EmbeddingProvider } from './EmbeddingProvider';
import { LocalEmbeddingProvider } from './LocalEmbeddingProvider';
import { GeminiEmbeddingProvider } from './GeminiEmbeddingProvider';
import { EmbeddingProviderId } from '../types/embeddingManifest';

export interface MakeProviderConfig {
  provider: EmbeddingProviderId;
  /** Required for gemini (single key). */
  apiKey?: string;
  /** Optional multiple keys for gemini, tried in order with 429 failover. */
  apiKeys?: string[];
  /** Required for local — the initialized Xenova pipeline. */
  extractor?: any;
}

export function makeEmbeddingProvider(cfg: MakeProviderConfig): EmbeddingProvider {
  if (cfg.provider === 'gemini') {
    const keys = cfg.apiKeys && cfg.apiKeys.length ? cfg.apiKeys : cfg.apiKey ? [cfg.apiKey] : [];
    if (!keys.length) throw new Error('Gemini embedding selected but no API key configured.');
    return new GeminiEmbeddingProvider(keys);
  }
  if (!cfg.extractor) throw new Error('Local embedding selected but model not initialized.');
  return new LocalEmbeddingProvider(cfg.extractor);
}
