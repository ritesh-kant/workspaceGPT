import fs from 'fs';
import path from 'path';
import { MODEL } from '../../../constants';
import { initializeEmbeddingModel } from 'src/utils/initializeEmbeddingModel';

let extractor: any;

interface WorkerData {
  query: string;
  embeddingDirPath: string;
}

interface SearchResult {
  text: string;
  score: number;
  source: string;
}

interface Metadata {
  id: number;
  filename: string;
  text: string;
  embedding: number[];
  url: string;
}

// Parse command line arguments
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('No arguments provided');
  process.exit(1);
}

const workerDataStr = args[0];
let workerData: WorkerData;

try {
  workerData = JSON.parse(workerDataStr);
} catch (error) {
  console.error('Failed to parse worker data:', error);
  process.exit(1);
}

const { query, embeddingDirPath } = workerData;

// Calculate cosine similarity between two vectors
function cosineSimilarity(a: number[], b: number[]): number {
  const dotProduct = a.reduce((sum, val, i) => sum + val * b[i], 0);
  const normA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const normB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
  return dotProduct / (normA * normB);
}

async function searchEmbeddings(): Promise<void> {
  try {
    // Check if embeddings exist
    const indexPath = path.join(embeddingDirPath, 'index.json');
    if (!fs.existsSync(indexPath)) {
      throw new Error(`Embedding index not found at: ${indexPath}`);
    }

    // Load index data
    const indexData = JSON.parse(fs.readFileSync(indexPath, 'utf8'));

    // Initialize embedding model
    // console.log('Initializing embedding model...');
    extractor = await initializeEmbeddingModel(
      MODEL.DEFAULT_TEXT_EMBEDDING_MODEL,
      embeddingDirPath,
      (progress: any) => {
        // console.log('Model download progress:', progress);
      }
    );
    // console.log('Model initialization complete');

    // Create embedding for query
    const queryEmbedding = await createEmbeddingForText(query);

    // Load all embeddings and calculate similarities
    const similarities: Array<{ id: number; score: number }> = [];

    for (let i = 0; i < indexData.total; i++) {
      const metadataPath = path.join(embeddingDirPath, `${i}.json`);

      if (!fs.existsSync(metadataPath)) {
        continue;
      }

      try {
        const metadata: Metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        const similarity = cosineSimilarity(queryEmbedding, metadata.embedding);
        similarities.push({ id: i, score: similarity });
      } catch (fileError) {
        continue;
      }
    }

    // Sort by similarity score and get top k results
    const k = 3;
    const topResults = similarities
      .sort((a, b) => b.score - a.score)
      .slice(0, k);

    // Load metadata and prepare results
    const results = await Promise.all(
      topResults.map(async ({ id, score }) => {
        const metadataPath = path.join(embeddingDirPath, `${id}.json`);
        const metadata: Metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        return {
          text: metadata.text,
          score: score,
          source: metadata.url
        } as SearchResult;
      })
    );

    // Send results back to parent process
    // console.log(JSON.stringify(results));
    process.exit(0);

  } catch (error) {
    console.error(JSON.stringify({
      type: 'error',
      message: error instanceof Error ? error.message : String(error)
    }));
    process.exit(1);
  }
}

// Create embedding using Xenova/Transformers
async function createEmbeddingForText(text: string): Promise<number[]> {
  try {
    // console.log(`Generating embedding for text of length ${text.length}...`);

    if (!extractor) {
      throw new Error('Embedding model not initialized');
    }

    const startTime = Date.now();
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    const duration = Date.now() - startTime;

    // console.log(`Embedding generation completed in ${duration}ms`);
    // console.log(`Generated embedding with ${output.data.length} dimensions`);

    return Array.from(output.data);
  } catch (error) {
    console.error('Error creating embedding:', error);
    throw error;
  }
}

// Start processing
searchEmbeddings();