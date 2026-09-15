/**
 * Standalone search engine for the MCP server.
 * Adapted from the VS Code extension's searchProcess.ts.
 *
 * Loads the same embedding files (.bin + meta.json) produced by the extension
 * and performs cosine similarity search with hybrid ID-boost scoring.
 */

import * as fs from 'fs';
import * as path from 'path';
import { type SearchResult, rerank } from './reranker.js';

// ── Constants (mirrored from the extension) ─────────────────────────────

const DEFAULT_TEXT_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
const MAX_SEARCH_RESULTS = 15;

// ── Types ───────────────────────────────────────────────────────────────

interface CachedEmbedding {
  filename: string;
  text: string;
  url: string;
  embeddingOffset: number;
}

type SourceNamespace = 'CONFLUENCE' | 'ADO' | 'JIRA';

interface SourceData {
  namespace: SourceNamespace;
  meta: CachedEmbedding[];
  matrix: Float32Array;
  norms: Float32Array;
  dimensions: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function computeNorm(arr: Float32Array, offset: number, dim: number): number {
  let sum = 0;
  const end = offset + dim;
  for (let i = offset; i < end; i++) {
    sum += arr[i]! * arr[i]!;
  }
  return Math.sqrt(sum);
}

function dotProduct(
  query: Float32Array,
  matrix: Float32Array,
  matrixOffset: number,
  dim: number
): number {
  let dot = 0;
  for (let i = 0; i < dim; i++) {
    dot += query[i]! * matrix[matrixOffset + i]!;
  }
  return dot;
}

// ── Search Engine ───────────────────────────────────────────────────────

export class SearchEngine {
  private dataDir: string;
  private extractor: any = null;
  private sources: Map<SourceNamespace, SourceData> = new Map();
  private initialized = false;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  /**
   * Initialize the embedding model and load all available embeddings.
   * This can take a few seconds on first run (model initialization).
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Dynamically import @xenova/transformers
    const { pipeline } = await import('@xenova/transformers');

    console.error('[WorkspaceGPT MCP] Initializing embedding model...');
    this.extractor = await pipeline('feature-extraction', DEFAULT_TEXT_EMBEDDING_MODEL, {
      quantized: true,
    });
    console.error('[WorkspaceGPT MCP] Embedding model loaded.');

    // Warm up the model
    await this.extractor('warmup', { pooling: 'mean', normalize: true });
    console.error('[WorkspaceGPT MCP] Model warmup complete.');

    // Load embeddings for each available source
    await this.loadSource('CONFLUENCE', path.join(this.dataDir, 'confluence', 'embeddings'));
    await this.loadSource('ADO', path.join(this.dataDir, 'ado', 'embeddings'));
    await this.loadSource('JIRA', path.join(this.dataDir, 'jira', 'embeddings'));

    this.initialized = true;

    const loadedSources = Array.from(this.sources.keys());
    console.error(`[WorkspaceGPT MCP] Ready. Available sources: ${loadedSources.join(', ') || 'none'}`);
  }

  /**
   * Load embeddings from a source directory (binary fast path, JSON fallback).
   */
  private async loadSource(namespace: SourceNamespace, embeddingDir: string): Promise<void> {
    if (!fs.existsSync(embeddingDir)) {
      console.error(`[WorkspaceGPT MCP] No embeddings found for ${namespace}, skipping.`);
      return;
    }

    const combinedPath = path.join(embeddingDir, 'embeddings.bin');
    const combinedMetaPath = path.join(embeddingDir, 'embeddings_meta.json');

    // Fast path: combined binary file
    if (fs.existsSync(combinedPath) && fs.existsSync(combinedMetaPath)) {
      try {
        const metaContent = await fs.promises.readFile(combinedMetaPath, 'utf8');
        const meta = JSON.parse(metaContent);
        const entries: CachedEmbedding[] = meta.entries;
        const dimensions: number = meta.dimensions;

        const buffer = await fs.promises.readFile(combinedPath);
        const matrix = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);

        const norms = new Float32Array(entries.length);
        for (let i = 0; i < entries.length; i++) {
          norms[i] = computeNorm(matrix, i * dimensions, dimensions);
        }

        this.sources.set(namespace, { namespace, meta: entries, matrix, norms, dimensions });
        console.error(`[WorkspaceGPT MCP] Loaded ${entries.length} ${namespace} embeddings from binary.`);
        return;
      } catch (err) {
        console.error(`[WorkspaceGPT MCP] Failed to load binary for ${namespace}, trying JSON fallback:`, err);
      }
    }

    // Slow path: individual JSON files
    await this.loadSourceFromJson(namespace, embeddingDir);
  }

  private async loadSourceFromJson(namespace: SourceNamespace, embeddingDir: string): Promise<void> {
    const indexPath = path.join(embeddingDir, 'index.json');
    if (!fs.existsSync(indexPath)) {
      console.error(`[WorkspaceGPT MCP] No index.json for ${namespace}, skipping.`);
      return;
    }

    const files = fs.readdirSync(embeddingDir)
      .filter(f => f.endsWith('.json') && f !== 'index.json' && f !== 'embeddings_meta.json');

    const results = await Promise.all(
      files.map(async (file) => {
        try {
          const content = await fs.promises.readFile(path.join(embeddingDir, file), 'utf8');
          return JSON.parse(content);
        } catch {
          return null;
        }
      })
    );

    const valid = results.filter((r): r is any => r !== null && r.embedding);
    if (valid.length === 0) return;

    const dimensions = valid[0].embedding.length;
    const matrix = new Float32Array(valid.length * dimensions);
    const meta: CachedEmbedding[] = [];
    const norms = new Float32Array(valid.length);

    for (let i = 0; i < valid.length; i++) {
      const r = valid[i];
      const offset = i * dimensions;
      for (let j = 0; j < dimensions; j++) {
        matrix[offset + j] = r.embedding[j];
      }
      meta.push({
        filename: r.filename,
        text: r.text,
        url: r.url,
        embeddingOffset: offset,
      });
      norms[i] = computeNorm(matrix, offset, dimensions);
    }

    this.sources.set(namespace, { namespace, meta, matrix, norms, dimensions });
    console.error(`[WorkspaceGPT MCP] Loaded ${meta.length} ${namespace} embeddings from JSON.`);
  }

  /**
   * Search a specific source or all sources.
   */
  async search(
    query: string,
    source: 'confluence' | 'ado' | 'jira' | 'all' = 'all',
    topK: number = 10
  ): Promise<SearchResult[]> {
    if (!this.initialized) {
      throw new Error('SearchEngine not initialized. Call initialize() first.');
    }

    const sourcesToSearch: SourceNamespace[] = [];
    if (source === 'all') {
      sourcesToSearch.push(...this.sources.keys());
    } else {
      const ns = source.toUpperCase() as SourceNamespace;
      if (this.sources.has(ns)) {
        sourcesToSearch.push(ns);
      }
    }

    if (sourcesToSearch.length === 0) {
      return [];
    }

    // Generate query embedding
    const output = await this.extractor(query, { pooling: 'mean', normalize: true });
    const queryEmbedding = new Float32Array(output.data);

    let queryNorm = 0;
    for (let i = 0; i < queryEmbedding.length; i++) {
      queryNorm += queryEmbedding[i]! * queryEmbedding[i]!;
    }
    queryNorm = Math.sqrt(queryNorm);

    // Search across selected sources
    const allResults: SearchResult[] = [];
    const normalizedQuery = query.toLowerCase().trim();
    const numberTokens = normalizedQuery.match(/\d+/g) || [];

    for (const ns of sourcesToSearch) {
      const src = this.sources.get(ns)!;
      const results = this.searchSingleSource(
        src, queryEmbedding, queryNorm, normalizedQuery, numberTokens, MAX_SEARCH_RESULTS
      );
      allResults.push(...results);
    }

    // Rerank and return
    return rerank(query, allResults, topK);
  }

  private searchSingleSource(
    src: SourceData,
    queryEmbedding: Float32Array,
    queryNorm: number,
    normalizedQuery: string,
    numberTokens: string[],
    topK: number
  ): SearchResult[] {
    const count = src.meta.length;
    if (count === 0) return [];

    const scores = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      const dot = dotProduct(queryEmbedding, src.matrix, i * src.dimensions, src.dimensions);
      const denom = queryNorm * src.norms[i]!;
      let score = denom === 0 ? 0 : dot / denom;

      const meta = src.meta[i]!;
      const filenameLower = meta.filename.toLowerCase();
      const textLower = meta.text.toLowerCase();

      // Hybrid boost: exact ID match in filename
      let hasIdMatch = false;
      for (const num of numberTokens) {
        if (filenameLower.includes(num)) {
          hasIdMatch = true;
          break;
        }
      }

      if (hasIdMatch) {
        score += 0.5;
      } else if (textLower.includes(normalizedQuery)) {
        score += 0.2;
      }

      scores[i] = score;
    }

    // Find top-K
    const k = Math.min(topK, count);
    const indices = Array.from({ length: count }, (_, i) => i);
    indices.sort((a, b) => scores[b]! - scores[a]!);
    const topIndices = indices.slice(0, k);

    return topIndices.map((idx) => ({
      text: src.meta[idx]!.text,
      score: scores[idx]!,
      data: {
        sourceName: src.namespace,
        source: src.meta[idx]!.url,
        fileName: src.meta[idx]!.filename,
      },
    }));
  }

  /**
   * Returns which sources have been loaded.
   */
  getAvailableSources(): string[] {
    return Array.from(this.sources.keys());
  }

  /**
   * Returns the count of loaded embeddings per source.
   */
  getStats(): Record<string, number> {
    const stats: Record<string, number> = {};
    for (const [ns, data] of this.sources) {
      stats[ns] = data.meta.length;
    }
    return stats;
  }
}
