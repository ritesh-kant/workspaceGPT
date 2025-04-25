import { parentPort, workerData } from 'worker_threads';
import fs from 'fs';
import path from 'path';
import { MODEL } from '../../../constants';

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
}

const { query, embeddingDirPath } = workerData as WorkerData;

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
      throw new Error('Embedding index not found');
    }

    // Create embedding for query
    const queryEmbedding = await createEmbeddingForText(query);

    // Load all embeddings and calculate similarities
    const indexData = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    const similarities: Array<{ id: number; score: number }> = [];

    for (let i = 0; i < indexData.total; i++) {
      const metadataPath = path.join(embeddingDirPath, `${i}.json`);
      const metadata: Metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
      const similarity = cosineSimilarity(queryEmbedding, metadata.embedding);
      similarities.push({ id: i, score: similarity });
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

// Create embedding using Ollama API
async function createEmbeddingForText(text: string): Promise<number[]> {
  try {
    const response = await fetch('http://localhost:11434/api/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL.DEFAULT_OLLAMA_EMBEDDING_MODEL,
        prompt: text
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to generate embeddings: ${response.statusText}`);
    }

    const result = await response.json();
    
    if (!result.embedding || !Array.isArray(result.embedding)) {
      throw new Error('Invalid embedding response from Ollama');
    }
    
    return result.embedding;
  } catch (error) {
    console.error('Error creating embedding:', error);
    throw error;
  }
}

// Start processing
searchEmbeddings();
