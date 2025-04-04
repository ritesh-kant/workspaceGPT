import { parentPort, workerData } from 'worker_threads';
import { WORKER_STATUS } from '../../constants';

interface WorkerData {
  modelId: string;
  globalStoragePath: string;
}

const { modelId } = workerData as WorkerData;

async function checkAndDownloadModel(): Promise<void> {
  try {
    // First check if the model exists
    const modelCheckResponse = await fetch(`http://localhost:11434/api/tags`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });

    if (!modelCheckResponse.ok) {
      throw new Error(`Failed to check model status: ${modelCheckResponse.statusText}`);
    }

    const modelList = await modelCheckResponse.json();
    const availableModels = modelList.models?.filter((model: { name: string }) => !model.name.includes("embed"));
    const modelExists = availableModels?.some((model: { name: string }) => model.name );
    
    if (modelExists) {
      parentPort?.postMessage({
        type: WORKER_STATUS.COMPLETED,
        message: 'Model already exists',
        models: availableModels
      });
      return;
    }

    // Pull the model using Ollama
    const response = await fetch(`http://localhost:11434/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelId })
    });

    if (!response.ok) {
      throw new Error(`Failed to pull model: ${response.statusText}`);
    }

    // Monitor download progress
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No reader available');

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = new TextDecoder().decode(value);
      const progress = JSON.parse(text);

      if (progress.status === 'downloading') {
        const downloadedSize = (progress.completed / 1024 / 1024).toFixed(2);
        const totalSize = (progress.total / 1024 / 1024).toFixed(2);
        const percentage = ((progress.completed / progress.total) * 100).toFixed(1);

        parentPort?.postMessage({
          type: WORKER_STATUS.PROCESSING,
          progress: percentage,
          current: `${downloadedSize} MB`,
          total: `${totalSize} MB`,
        });
      }
    }

    parentPort?.postMessage({
      type: WORKER_STATUS.COMPLETED,
      message: 'Model initialization completed successfully',
      models: [{name: modelId}]
    });
  } catch (error) {
    parentPort?.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

// Start processing
checkAndDownloadModel();