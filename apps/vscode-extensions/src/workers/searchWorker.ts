import { parentPort, workerData } from 'worker_threads';
import fs from 'fs';
import path from 'path';
import { HierarchicalNSW } from 'hnswlib-node';

interface WorkerData {
  query: string;
  embeddingDirPath: string;
}

interface SearchResult {
  text: string;
  score: number;
  source: string;
}

const { query, embeddingDirPath } = workerData as WorkerData;

async function searchEmbeddings(): Promise<void> {
  try {
    // Load the index
    const indexPath = path.join(embeddingDirPath, 'index.bin');
    if (!fs.existsSync(indexPath)) {
      throw new Error('Embedding index not found');
    }

    // Initialize HNSW index
    const index = new HierarchicalNSW('cosine', 384); // Using default dimension for all-MiniLM-L6-v2
    index.readIndex(indexPath);

    // Create embedding for query
    const queryEmbedding = await createEmbeddingForText(query);

    // Search for similar embeddings
    const k = 3; // Number of nearest neighbors to retrieve
    const { neighbors, distances } = index.searchKnn(queryEmbedding, k);

    // Load metadata and prepare results
    const results = await Promise.all(
      neighbors.map(async (id: number, i: number) => {
        const metadataPath = path.join(embeddingDirPath, `${id}.json`);
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        return {
          text: metadata.text,
          score: 1 - distances[i], // Convert distance to similarity score
          source: metadata.filename
        } as SearchResult;
      })
    );

    // Send results back to main thread
    parentPort?.postMessage(results);

  } catch (error) {
    parentPort?.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

// Using dynamic import for ESM compatibility
let pipeline: any;
let transformers: any;
let extractor: any;

// Create embedding using all-MiniLM-L6-v2 model
async function createEmbeddingForText(text: string): Promise<number[]> {
  try {
    if (!extractor) {
      transformers = await import('@xenova/transformers');
      pipeline = transformers.pipeline;
      extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    }
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data).map(Number);
  } catch (error) {
    console.error('Error creating embedding:', error);
    throw error;
  }
}

// Start processing
searchEmbeddings();