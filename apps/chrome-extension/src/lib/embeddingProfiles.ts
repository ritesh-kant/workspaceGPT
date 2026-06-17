import { EmbeddingIdentity, EmbeddingProviderId } from './embeddingManifest';

// Chrome only uses Gemini; local is kept for shape parity with the VS Code side.
export const EMBEDDING_PROFILES: Record<EmbeddingProviderId, EmbeddingIdentity> = {
  local: {
    provider: 'local',
    model: 'Xenova/all-MiniLM-L6-v2',
    dimensions: 384,
    normalized: true,
  },
  gemini: {
    provider: 'gemini',
    model: 'gemini-embedding-001',
    dimensions: 768,
    normalized: true,
  },
};
