import fs from 'fs';
import path from 'path';
import { MODEL, SEARCH_CONSTANTS } from '../../../constants';
import { initializeEmbeddingModel } from '../utils/initializeEmbeddingModel';

// ── Types ──────────────────────────────────────────────────────────────

interface SearchResult {
  text: string;
  score: number;
  data: {
    sourceName: 'CONFLUENCE' | 'CODEBASE';
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
}

interface SearchMessage {
  type: 'search';
  query: string;
}

interface ReloadMessage {
  type: 'reload';
  embeddingDirPath: string;
}

type WorkerMessage = InitMessage | SearchMessage | ReloadMessage;

// ── State (lives for the lifetime of this process) ─────────────────────

let extractor: any = null;
let embeddingsMeta: CachedEmbedding[] = [];
let embeddingsMatrix: Float32Array = new Float32Array(0); // flat array: N embeddings × D dimensions
let embeddingNorms: Float32Array = new Float32Array(0);   // pre-computed norms
let dimensions: number = 0;
let currentEmbeddingDirPath: string = '';

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

async function initializeModel(embeddingDirPath: string): Promise<void> {
  if (extractor) {
    console.log('SearchWorker: Model already initialized, skipping.');
    return;
  }

  console.log('SearchWorker: Initializing embedding model...');
  extractor = await initializeEmbeddingModel(
    MODEL.DEFAULT_TEXT_EMBEDDING_MODEL,
    embeddingDirPath,
    (progress: any) => {
      console.log('SearchWorker: Model load progress:', progress);
    }
  );
  console.log('SearchWorker: Model initialization complete.');

  // Model warmup — run a dummy embedding to JIT-compile the ONNX runtime
  console.log('SearchWorker: Warming up model...');
  const warmupStart = Date.now();
  await extractor('warmup', { pooling: 'mean', normalize: true });
  console.log(`SearchWorker: Model warmup done in ${Date.now() - warmupStart}ms`);
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

async function createEmbeddingForText(text: string): Promise<Float32Array> {
  if (!extractor) {
    throw new Error('Embedding model not initialized');
  }
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return new Float32Array(output.data);
}

async function handleSearch(query: string): Promise<void> {
  try {
    if (!extractor) {
      throw new Error('Model not initialized. Send "init" first.');
    }

    console.log('SearchWorker: Searching for:', query);

    // Generate query embedding as Float32Array
    const queryEmbedding = await createEmbeddingForText(query);
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
      scores[i] = denom === 0 ? 0 : dot / denom;
    }

    // Find top k results using partial sort
    const k = Math.min(SEARCH_CONSTANTS.MAX_SEARCH_RESULTS, count);
    const indices = Array.from({ length: count }, (_, i) => i);
    indices.sort((a, b) => scores[b] - scores[a]);
    const topIndices = indices.slice(0, k);

    // Build results directly from cache
    const results: SearchResult[] = topIndices.map((idx) => ({
      text: embeddingsMeta[idx].text,
      score: scores[idx],
      data: {
        sourceName: 'CONFLUENCE',
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
        await initializeModel(msg.embeddingDirPath);
        await loadAllEmbeddings(msg.embeddingDirPath);
        process.send!({ type: 'ready' });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        process.send!({ type: 'error', message: `Init failed: ${errorMessage}` });
      }
      break;
    }

    case 'search': {
      await handleSearch(msg.query);
      break;
    }

    case 'reload': {
      try {
        await loadAllEmbeddings(msg.embeddingDirPath || currentEmbeddingDirPath);
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