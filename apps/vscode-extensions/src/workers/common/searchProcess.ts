import fs from 'fs';
import path from 'path';
import { MODEL, SEARCH_CONSTANTS } from '../../../constants';
import { initializeEmbeddingModel } from '../utils/initializeEmbeddingModel';
import { EmbeddingProvider, embedOne } from '../../embeddings/EmbeddingProvider';
import { makeEmbeddingProvider } from '../../embeddings/makeProvider';
import { checkEmbeddingCompat } from '../../utils/embeddingCompat';
import { EmbeddingIdentity, EmbeddingProviderId } from '../../types/embeddingManifest';
import { makeVectorStore } from '../../vectorstore/makeVectorStore';
import { VectorStore } from '../../vectorstore/VectorStore';

interface VectorStoreSettingsMsg {
  location: 'local' | 'cloud';
  qdrantUrl?: string;
  qdrantApiKey?: string;
}

// ── Types ──────────────────────────────────────────────────────────────

interface SearchResult {
  text: string;
  score: number;
  data: {
    sourceName: 'CONFLUENCE' | 'ADO' | 'JIRA';
    source: string;
    fileName: string;
  };
}

interface CachedEmbedding {
  filename: string;
  text: string;
  url: string;
  embeddingOffset: number; // index into the flat Float32Array
}
interface InitMessage {
  type: 'init';
  embeddingDirPath: string;
  namespace?: string;
  provider?: EmbeddingProviderId;
  apiKey?: string;
  apiKeys?: string[];
  vectorStore?: VectorStoreSettingsMsg;
}

interface SearchMessage {
  type: 'search';
  query: string;
  topK?: number;
  namespace?: string;
}

interface ReloadMessage {
  type: 'reload';
  embeddingDirPath: string;
  namespace?: string;
  provider?: EmbeddingProviderId;
  apiKey?: string;
  apiKeys?: string[];
  vectorStore?: VectorStoreSettingsMsg;
}

type WorkerMessage = InitMessage | SearchMessage | ReloadMessage;

// ── State (lives for the lifetime of this process) ─────────────────────

let extractor: any = null;
let queryProvider: EmbeddingProvider | null = null;
let currentProviderId: EmbeddingProviderId | null = null;
let indexIdentity: EmbeddingIdentity | null = null;
let compatError: string | null = null;
let vectorStore: VectorStore | null = null; // non-null = cloud (Qdrant); null = local file path
let embeddingsMeta: CachedEmbedding[] = [];
let embeddingsMatrix: Float32Array = new Float32Array(0); // flat array: N embeddings × D dimensions
let embeddingNorms: Float32Array = new Float32Array(0);   // pre-computed norms
let dimensions: number = 0;
let currentEmbeddingDirPath: string = '';
let currentNamespace: 'CONFLUENCE' | 'ADO' | 'JIRA' = 'CONFLUENCE';

// ── Helpers ────────────────────────────────────────────────────────────

function computeNorm(arr: Float32Array, offset: number, dim: number): number {
  let sum = 0;
  const end = offset + dim;
  for (let i = offset; i < end; i++) {
    sum += arr[i] * arr[i];
  }
  return Math.sqrt(sum);
}

/**
 * Fast cosine similarity using pre-computed norm for the stored embedding.
 * Query norm is also pre-computed once per search.
 */
function dotProduct(
  query: Float32Array,
  matrix: Float32Array,
  matrixOffset: number,
  dim: number
): number {
  let dot = 0;
  for (let i = 0; i < dim; i++) {
    dot += query[i] * matrix[matrixOffset + i];
  }
  return dot;
}

// ── Core Functions ─────────────────────────────────────────────────────

/**
 * Build the query embedding provider matching the user's selection. Local lazily
 * initializes (and warms up) the ONNX model; Gemini just needs the API key.
 */
async function initializeProvider(
  providerId: EmbeddingProviderId,
  apiKey: string | undefined,
  embeddingDirPath: string,
  apiKeys?: string[]
): Promise<void> {
  if (queryProvider && providerId === currentProviderId) {
    return; // already initialized for this provider
  }
  currentProviderId = providerId;

  if (providerId === 'local') {
    if (!extractor) {
      console.log('SearchWorker: Initializing local embedding model...');
      extractor = await initializeEmbeddingModel(
        MODEL.DEFAULT_TEXT_EMBEDDING_MODEL,
        embeddingDirPath,
        (progress: any) => console.log('SearchWorker: Model load progress:', progress)
      );
      // Warmup — JIT-compile the ONNX runtime so the first query is fast
      const warmupStart = Date.now();
      await extractor('warmup', { pooling: 'mean', normalize: true });
      console.log(`SearchWorker: Model warmup done in ${Date.now() - warmupStart}ms`);
    }
    queryProvider = makeEmbeddingProvider({ provider: 'local', extractor });
  } else {
    console.log('SearchWorker: Using Gemini for query embeddings.');
    queryProvider = makeEmbeddingProvider({ provider: 'gemini', apiKey, apiKeys });
  }
}

/** Build a cloud (Qdrant) store from init settings, or null for the local file path. */
function buildVectorStore(vs?: VectorStoreSettingsMsg): VectorStore | null {
  if (vs?.location === 'cloud' && vs.qdrantUrl) {
    return makeVectorStore({
      location: 'cloud',
      qdrant: { url: vs.qdrantUrl, apiKey: vs.qdrantApiKey },
    });
  }
  return null;
}

/** Read the index's embedding identity from its manifest (null for legacy/no index). */
function loadIndexIdentity(embeddingDirPath: string): EmbeddingIdentity | null {
  try {
    const p = path.join(embeddingDirPath, 'index.json');
    if (!fs.existsSync(p)) return null;
    const manifest = JSON.parse(fs.readFileSync(p, 'utf8'));
    return manifest.embedding ?? null;
  } catch {
    return null;
  }
}

/** Compare the query provider against the index identity; set compatError on mismatch. */
function recomputeCompat(): void {
  if (!indexIdentity || !queryProvider) {
    compatError = null; // legacy index (no manifest) — assume compatible
    return;
  }
  const result = checkEmbeddingCompat({ embedding: indexIdentity }, queryProvider.identity);
  compatError = result.ok ? null : (result.reason ?? 'Embedding model mismatch — re-index required.');
  if (compatError) console.warn('SearchWorker: index/query mismatch:', compatError);
}

/**
 * Try to load from a combined binary file first (fast path).
 * Falls back to reading individual JSON files (slow path).
 */
async function loadAllEmbeddings(embeddingDirPath: string): Promise<void> {
  console.log('SearchWorker: Loading embeddings...');
  currentEmbeddingDirPath = embeddingDirPath;

  const combinedPath = path.join(embeddingDirPath, 'embeddings.bin');
  const combinedMetaPath = path.join(embeddingDirPath, 'embeddings_meta.json');

  // Fast path: combined binary file
  if (fs.existsSync(combinedPath) && fs.existsSync(combinedMetaPath)) {
    try {
      const loadStart = Date.now();

      // Read metadata
      const metaContent = await fs.promises.readFile(combinedMetaPath, 'utf8');
      const meta = JSON.parse(metaContent);
      embeddingsMeta = meta.entries;
      dimensions = meta.dimensions;

      // Read binary embeddings as Float32Array
      const buffer = await fs.promises.readFile(combinedPath);
      embeddingsMatrix = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);

      // Pre-compute norms
      embeddingNorms = new Float32Array(embeddingsMeta.length);
      for (let i = 0; i < embeddingsMeta.length; i++) {
        embeddingNorms[i] = computeNorm(embeddingsMatrix, i * dimensions, dimensions);
      }

      console.log(`SearchWorker: Loaded ${embeddingsMeta.length} embeddings from binary in ${Date.now() - loadStart}ms`);
      return;
    } catch (err) {
      console.warn('SearchWorker: Failed to load binary embeddings, falling back to JSON:', err);
    }
  }

  // Slow path: individual JSON files
  await loadFromJsonFiles(embeddingDirPath);
}

async function loadFromJsonFiles(embeddingDirPath: string): Promise<void> {
  const indexPath = path.join(embeddingDirPath, 'index.json');
  if (!fs.existsSync(indexPath)) {
    console.log('SearchWorker: No index.json found, cache is empty.');
    embeddingsMeta = [];
    embeddingsMatrix = new Float32Array(0);
    embeddingNorms = new Float32Array(0);
    dimensions = 0;
    return;
  }

  const loadStart = Date.now();

  // Get all json files except index.json and meta files
  const files = fs.readdirSync(embeddingDirPath)
    .filter(f => f.endsWith('.json') && f !== 'index.json' && f !== 'embeddings_meta.json');

  // Read all files in parallel
  const results = await Promise.all(
    files.map(async (file) => {
      try {
        const filePath = path.join(embeddingDirPath, file);
        const content = await fs.promises.readFile(filePath, 'utf8');
        return JSON.parse(content);
      } catch {
        return null;
      }
    })
  );

  const validResults = results.filter((r): r is any => r !== null && r.embedding);

  if (validResults.length === 0) {
    embeddingsMeta = [];
    embeddingsMatrix = new Float32Array(0);
    embeddingNorms = new Float32Array(0);
    dimensions = 0;
    return;
  }

  // Pack into Float32Array
  dimensions = validResults[0].embedding.length;
  embeddingsMatrix = new Float32Array(validResults.length * dimensions);
  embeddingsMeta = [];
  embeddingNorms = new Float32Array(validResults.length);

  for (let i = 0; i < validResults.length; i++) {
    const r = validResults[i];
    const offset = i * dimensions;
    const embedding = r.embedding;
    for (let j = 0; j < dimensions; j++) {
      embeddingsMatrix[offset + j] = embedding[j];
    }
    embeddingsMeta.push({
      filename: r.filename,
      text: r.text,
      url: r.url,
      embeddingOffset: offset,
    });
    embeddingNorms[i] = computeNorm(embeddingsMatrix, offset, dimensions);
  }

  // Write combined binary for next time (async, don't await)
  writeCombinedBinaryFile(embeddingDirPath).catch(err =>
    console.warn('SearchWorker: Failed to write binary cache:', err)
  );

  console.log(`SearchWorker: Loaded ${embeddingsMeta.length} embeddings from JSON in ${Date.now() - loadStart}ms`);
}

/**
 * Write combined binary file for fast loading next time,
 * then delete individual JSON embedding files.
 */
async function writeCombinedBinaryFile(embeddingDirPath: string): Promise<void> {
  const combinedPath = path.join(embeddingDirPath, 'embeddings.bin');
  const combinedMetaPath = path.join(embeddingDirPath, 'embeddings_meta.json');

  // Write binary matrix
  const buffer = Buffer.from(embeddingsMatrix.buffer, embeddingsMatrix.byteOffset, embeddingsMatrix.byteLength);
  await fs.promises.writeFile(combinedPath, buffer);

  // Write metadata (without embeddings — those are in the binary)
  const meta = {
    dimensions,
    count: embeddingsMeta.length,
    entries: embeddingsMeta,
  };
  await fs.promises.writeFile(combinedMetaPath, JSON.stringify(meta));

  // Clean up individual JSON files — they're now redundant
  const keepFiles = new Set(['index.json', 'embeddings_meta.json']);
  const files = await fs.promises.readdir(embeddingDirPath);
  const jsonFiles = files.filter(f => f.endsWith('.json') && !keepFiles.has(f));

  let deletedCount = 0;
  await Promise.all(
    jsonFiles.map(async (file) => {
      try {
        await fs.promises.unlink(path.join(embeddingDirPath, file));
        deletedCount++;
      } catch { /* ignore */ }
    })
  );

  console.log(`SearchWorker: Written combined binary cache. Deleted ${deletedCount} individual JSON files.`);
}

async function handleSearch(query: string, topK?: number): Promise<void> {
  try {
    if (compatError) {
      throw new Error(compatError);
    }
    if (!queryProvider) {
      throw new Error('Provider not initialized. Send "init" first.');
    }

    console.log('SearchWorker: Searching for:', query);

    // Generate query embedding (provider-matched to the index)
    const queryVec = await embedOne(queryProvider, query, 'query');

    const normalizedQuery = query.toLowerCase().trim();
    const numberTokens = normalizedQuery.match(/\d+/g) || [];

    // ── Cloud path: Qdrant KNN, then re-apply lexical boosts to preserve hybrid search ──
    if (vectorStore) {
      const k = topK ?? SEARCH_CONSTANTS.MAX_SEARCH_RESULTS;
      // Over-fetch a candidate pool so the lexical boost can reorder meaningfully.
      const hits = await vectorStore.search(queryVec, Math.max(k * 3, 30), currentNamespace);
      for (const h of hits) {
        if (numberTokens.some((num) => h.data.fileName.toLowerCase().includes(num))) {
          h.score += 0.5;
        } else if (h.text.toLowerCase().includes(normalizedQuery)) {
          h.score += 0.2;
        }
      }
      hits.sort((a, b) => b.score - a.score);
      const results = hits.slice(0, k);
      console.log(`SearchWorker: Returning ${results.length} results (cloud).`);
      process.send!({ type: 'results', data: results });
      return;
    }

    // ── Local path: in-memory cosine over the loaded matrix ──
    const queryEmbedding = new Float32Array(queryVec);
    let queryNorm = 0;
    for (let i = 0; i < queryEmbedding.length; i++) {
      queryNorm += queryEmbedding[i] * queryEmbedding[i];
    }
    queryNorm = Math.sqrt(queryNorm);

    // Compute similarities — pure typed-array math, no object allocation
    const count = embeddingsMeta.length;
    const scores = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      const dot = dotProduct(queryEmbedding, embeddingsMatrix, i * dimensions, dimensions);
      const denom = queryNorm * embeddingNorms[i];
      let score = denom === 0 ? 0 : dot / denom;

      // HYBRID SEARCH BOOST: Lexical matching for exact IDs/phrases
      const meta = embeddingsMeta[i];
      const filenameLower = meta.filename.toLowerCase();
      const textLower = meta.text.toLowerCase();

      // 1. Exact ID/Filename match (E.g. query "tell me about 1224706" extracts "1224706" and matches "ADO-1224706")
      let hasIdMatch = false;
      for (const num of numberTokens) {
        if (filenameLower.includes(num)) {
          hasIdMatch = true;
          break;
        }
      }

      if (hasIdMatch) {
        score += 0.5;
      }
      // 2. Exact phrase match in the document text -> Moderate +0.2 boost
      else if (textLower.includes(normalizedQuery)) {
        score += 0.2;
      }

      scores[i] = score;
    }

    // Find top k results using partial sort
    const k = Math.min(topK ?? SEARCH_CONSTANTS.MAX_SEARCH_RESULTS, count);
    const indices = Array.from({ length: count }, (_, i) => i);
    indices.sort((a, b) => scores[b] - scores[a]);
    const topIndices = indices.slice(0, k);

    // Build results directly from cache
    const results: SearchResult[] = topIndices.map((idx) => ({
      text: embeddingsMeta[idx].text,
      score: scores[idx],
      data: {
        sourceName: currentNamespace,
        source: embeddingsMeta[idx].url,
        fileName: embeddingsMeta[idx].filename,
      },
    }));

    console.log(`SearchWorker: Returning ${results.length} results.`);
    process.send!({ type: 'results', data: results });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('SearchWorker: Search error:', errorMessage);
    process.send!({ type: 'error', message: errorMessage });
  }
}

// ── Message Handler (persistent worker loop) ───────────────────────────

process.on('message', async (msg: WorkerMessage) => {
  switch (msg.type) {
    case 'init': {
      try {
        if (msg.namespace) {
          currentNamespace = msg.namespace as 'CONFLUENCE' | 'ADO' | 'JIRA';
        }
        await initializeProvider(msg.provider ?? 'local', msg.apiKey, msg.embeddingDirPath, msg.apiKeys);
        vectorStore = buildVectorStore(msg.vectorStore);
        if (vectorStore) {
          // Cloud: Qdrant holds the vectors; dimension match is enforced server-side.
          compatError = null;
        } else {
          await loadAllEmbeddings(msg.embeddingDirPath);
          indexIdentity = loadIndexIdentity(msg.embeddingDirPath);
          recomputeCompat();
        }
        process.send!({ type: 'ready' });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        process.send!({ type: 'error', message: `Init failed: ${errorMessage}` });
      }
      break;
    }

    case 'search': {
      await handleSearch(msg.query, msg.topK);
      break;
    }

    case 'reload': {
      try {
        const dir = msg.embeddingDirPath || currentEmbeddingDirPath;
        if (msg.provider) {
          await initializeProvider(msg.provider, msg.apiKey, dir, msg.apiKeys);
        }
        vectorStore = buildVectorStore(msg.vectorStore);
        if (vectorStore) {
          compatError = null;
        } else {
          await loadAllEmbeddings(dir);
          indexIdentity = loadIndexIdentity(dir);
          recomputeCompat();
        }
        process.send!({ type: 'reloaded' });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        process.send!({ type: 'error', message: `Reload failed: ${errorMessage}` });
      }
      break;
    }
  }
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('SearchWorker: Received SIGTERM, shutting down.');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SearchWorker: Received SIGINT, shutting down.');
  process.exit(0);
});

console.log('SearchWorker: Process started, waiting for messages...');
