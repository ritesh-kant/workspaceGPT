import { workerData, parentPort } from 'worker_threads';
import { readFile, readdir } from 'fs/promises';
import * as path from 'path';

// Define worker data interface
interface WorkerData {
  query: string;
  embeddingDirPath: string;
}

// Define embedding result interface
interface EmbeddingResult {
  filename: string;
  filePath: string;
  embedding: number[];
}

// Define search result interface
interface SearchResult {
  text: string;
  score: number;
  source: string;
}

const importModule = new Function('modulePath', 'return import(modulePath)');
// Extract worker data
const { query, embeddingDirPath } = workerData as WorkerData;

// Function to load all embeddings
async function loadEmbeddings(): Promise<EmbeddingResult[]> {
  try {
    const files = await readdir(embeddingDirPath);
    const embeddingFiles = files.filter(file => file.endsWith('.embedding.json'));
    
    const embeddings: EmbeddingResult[] = [];
    for (const file of embeddingFiles) {
      const content = await readFile(path.join(embeddingDirPath, file), 'utf8');
      const data = JSON.parse(content) as EmbeddingResult;
      embeddings.push(data);
    }
    
    return embeddings;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error loading embeddings:', errorMessage);
    return [];
  }
}

// Function to calculate cosine similarity
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Vectors must have the same length');
  }
  
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  
  if (normA === 0 || normB === 0) {
    return 0;
  }
  
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Main function to search embeddings
async function searchEmbeddings(): Promise<void> {
  try {
    // Initialize the model
    const { pipeline } = await importModule('@xenova/transformers');

    const extractor = await pipeline('feature-extraction', 'jinaai/jina-embeddings-v2-base-code');
    
    // Generate embedding for the query
    const queryEmbedding = await extractor(query, { pooling: 'mean', normalize: true });
    const queryEmbeddingArray: number[] = Array.from(queryEmbedding.data);
    
    // Load all embeddings
    const embeddings = await loadEmbeddings();
    
    if (embeddings.length === 0) {
      if (parentPort) {
        parentPort.postMessage([]);
      }
      return;
    }
    
    // Calculate similarity scores
    const results: SearchResult[] = embeddings.map(item => {
      const similarity = cosineSimilarity(queryEmbeddingArray, item.embedding as number[]);
      return {
        text: item.filename,
        score: similarity,
        source: item.filePath,
      };
    });
    
    // Sort by similarity score (descending)
    results.sort((a, b) => b.score - a.score);
    
    // Return top results
    if (parentPort) {
      parentPort.postMessage(results.slice(0, 5));
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error searching embeddings:', errorMessage);
    if (parentPort) {
      parentPort.postMessage([]);
    }
  }
}

// Start the search
searchEmbeddings();