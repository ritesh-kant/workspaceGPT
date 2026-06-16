import { EmbeddingIdentity, EmbeddingProviderId } from '../types/embeddingManifest';

/**
 * Canonical embedding identities, defined once so VS Code and Chrome can't drift.
 * Gemini is pinned to 768 dims (MRL truncation) — ~4x smaller index for the share
 * transport and the Qdrant free tier, with a small recall cost vs 3072.
 */
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
