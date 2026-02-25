import fs from 'fs';
import path from 'path';
import { MODEL, SEARCH_CONSTANTS } from '../../../constants';
import { initializeEmbeddingModel } from '../utils/initializeEmbeddingModel';

let extractor: any;

interface WorkerData {
  query: string;
  embeddingDirPath: string;
}

interface SearchResult {
  text: string;
  score: number;
  data: {
    sourceName: 'CONFLUENCE' | 'CODEBASE';
    source: string;
    fileName: string;
  };
}

interface Metadata {
  id: number;
  filename: string;
  text: string;
  embedding: number[];
  url: string;
}

let workerData: WorkerData;

const workerDataStr = process.env.workerData;
workerData = JSON.parse(workerDataStr!);
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
    console.log('SearchWorker : Starting searchEmbeddings function...');

    // Check if embeddings exist
    const indexPath = path.join(embeddingDirPath, 'index.json');
    console.log('SearchWorker : Checking for index at:', indexPath);

    if (!fs.existsSync(indexPath)) {
      console.log(`Embedding index not found at: ${indexPath}`);
      process.send!({
        type: 'results',
        data: [],
      });
      process.exit(0);
    }

    console.log('SearchWorker : Index file found, proceeding with search...');

    // Load index data
    const indexData = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    console.log('SearchWorker : Index data loaded:', indexData);

    // Initialize embedding model
    console.log('SearchWorker : Initializing embedding model...');
    extractor = await initializeEmbeddingModel(
      MODEL.DEFAULT_TEXT_EMBEDDING_MODEL,
      embeddingDirPath,
      (progress: any) => {
        console.log('SearchWorker : Model download progress:', progress);
      }
    );
    console.log('SearchWorker : Model initialization complete');

    // Create embedding for query
    console.log('SearchWorker : Creating embedding for query:', query);
    const queryEmbedding = await createEmbeddingForText(query);
    console.log(
      'SearchWorker : Query embedding created, length:',
      queryEmbedding.length
    );

    // Load all embeddings and calculate similarities
    console.log(
      'SearchWorker : Loading embeddings and calculating similarities...'
    );
    const similarities: Array<{ id: string; score: number }> = [];

    // Get all json files except index.json
    const files = fs.readdirSync(embeddingDirPath)
      .filter(f => f.endsWith('.json') && f !== 'index.json');

    for (const file of files) {
      const metadataPath = path.join(embeddingDirPath, file);

      try {
        const metadata: Metadata = JSON.parse(
          fs.readFileSync(metadataPath, 'utf8')
        );
        const similarity = cosineSimilarity(queryEmbedding, metadata.embedding);
        similarities.push({ id: file.replace('.json', ''), score: similarity });
      } catch (fileError) {
        continue;
      }
    }

    // Sort by similarity score and get top k results
    console.log('SearchWorker : Found', similarities.length, 'similarities');
    const k = SEARCH_CONSTANTS.MAX_SEARCH_RESULTS;
    const topResults = similarities
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
    console.log('SearchWorker : Top results:', topResults);

    // Load metadata and prepare results
    console.log('SearchWorker : Loading metadata for top results...');
    const results = await Promise.all(
      topResults.map(async ({ id, score }) => {
        console.log(`SearchWorker : Loading metadata for id: ${id}`);
        const metadataPath = path.join(embeddingDirPath, `${id}.json`);
        console.log(`SearchWorker : Metadata path: ${metadataPath}`);
        const metadata: Metadata = JSON.parse(
          fs.readFileSync(metadataPath, 'utf8')
        );
        console.log(`SearchWorker : Loaded metadata for: ${metadata.filename}`);
        return {
          text: metadata.text,
          score: score,
          data: {
            sourceName: 'CONFLUENCE',
            source: metadata.url,
            fileName: metadata.filename,
          },
        } as SearchResult;
      })
    );
    console.log('SearchWorker : All metadata loaded successfully');

    console.log(
      'SearchWorker : Sending results back to parent:',
      results.length,
      'results'
    );
    // Send results back to parent process via IPC
    process.send!({
      type: 'results',
      data: results,
    });
    console.log('SearchWorker : Results sent, exiting...');
    // process.exit(results.length);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Send error back to parent process via IPC
    process.send!({
      type: 'error',
      message: errorMessage,
    });
    process.exit(1);
  }
}

// Create embedding using Xenova/Transformers
async function createEmbeddingForText(text: string): Promise<number[]> {
  try {
    // console.log(`SearchWorker : Generating embedding for text of length ${text.length}...`);

    if (!extractor) {
      throw new Error('Embedding model not initialized');
    }

    const output = await extractor(text, { pooling: 'mean', normalize: true });

    return Array.from(output.data);
  } catch (error) {
    console.error('Error creating embedding:', error);
    throw error;
  }
}

// Start processing
searchEmbeddings();