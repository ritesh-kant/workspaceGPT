import { parentPort, workerData } from 'worker_threads';
import fs from 'fs';
import path from 'path';
import MarkdownIt from 'markdown-it';
import { EmbeddingConfig } from 'src/types/types';
import { MODEL, WORKER_STATUS } from '../../constants';

let md: MarkdownIt;
let ollamaModel: string;

interface WorkerData {
  mdDirPath: string;
  embeddingDirPath: string;
  config: EmbeddingConfig;
}

interface Metadata {
  id: number;
  filename: string;
  text: string;
  embedding: number[];
}

const { mdDirPath, embeddingDirPath, config } = workerData as WorkerData;

// Initialize markdown-it
md = new MarkdownIt({ html: false });

async function createEmbeddings(): Promise<void> {
  try {
    const files = fs
      .readdirSync(mdDirPath)
      .filter((file) => file.endsWith('.md'));
    const total = files.length;

    // Create embeddings directory if it doesn't exist
    if (!fs.existsSync(embeddingDirPath)) {
      fs.mkdirSync(embeddingDirPath, { recursive: true });
    }

    // Process each file
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const filePath = path.join(mdDirPath, file);
      const markdownContent = fs.readFileSync(filePath, 'utf8');
      // Convert markdown to structured plain text
      const content = md
        .render(markdownContent)
        .replace(/<[^>]*>/g, '')
        .trim();

      // Create embedding for the content using all-MiniLM-L6-v2
      const embedding = await createEmbeddingForText(content);

      // Store metadata with embedding
      const metadata: Metadata = {
        id: i,
        filename: file,
        text: content,
        embedding: embedding
      };

      // Save metadata
      fs.writeFileSync(
        path.join(embeddingDirPath, `${i}.json`),
        JSON.stringify(metadata)
      );

      // Report progress
      parentPort?.postMessage({
        type: WORKER_STATUS.PROCESSING,
        progress: (((i + 1) / total) * 100).toFixed(1),
        current: i + 1,
        total,
      });
    }

    // Save index metadata
    fs.writeFileSync(
      path.join(embeddingDirPath, 'index.json'),
      JSON.stringify({
        total: total,
        dimensions: config.dimensions
      })
    );

    // Complete
    parentPort?.postMessage({ type: WORKER_STATUS.COMPLETED });
    console.log('Embeddings created successfully!');
  } catch (error) {
    parentPort?.postMessage({
      type: WORKER_STATUS.ERROR,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

// Check if model exists in Ollama and download if needed
async function checkAndDownloadModel(modelName: string): Promise<boolean> {
  try {
    // First check if the model exists
    const modelCheckResponse = await fetch('http://localhost:11434/api/tags', {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });

    if (!modelCheckResponse.ok) {
      throw new Error(`Failed to check model status: ${modelCheckResponse.statusText}`);
    }

    const modelList = await modelCheckResponse.json();
    const modelExists = modelList.models?.some((model: { name: string }) => model.name === modelName);

    if (modelExists) {
      console.log(`Model ${modelName} already exists`);
      return true;
    }

    // Model doesn't exist, pull it
    console.log(`Model ${modelName} not found, downloading...`);
    parentPort?.postMessage({
      type: WORKER_STATUS.PROCESSING,
      progress: '0',
      current: 0,
      total: 1,
      message: `Downloading embedding model ${modelName}...`
    });

    const pullResponse = await fetch('http://localhost:11434/api/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName })
    });

    if (!pullResponse.ok) {
      throw new Error(`Failed to pull model: ${pullResponse.statusText}`);
    }

    console.log(`Model ${modelName} downloaded successfully`);
    return true;
  } catch (error) {
    console.error('Error checking/downloading model:', error);
    throw error;
  }
}

// Create embedding using Ollama API
async function createEmbeddingForText(
  text: string,
): Promise<number[]> {
  try {
    // Ensure model is available
    if (!ollamaModel) {
      ollamaModel = config.modelName || MODEL.DEFAULT_OLLAMA_EMBEDDING_MODEL;
      await checkAndDownloadModel(ollamaModel);
    }

    const response = await fetch('http://localhost:11434/api/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ollamaModel,
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
createEmbeddings();
