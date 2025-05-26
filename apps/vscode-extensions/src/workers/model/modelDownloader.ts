import { parentPort, workerData } from 'worker_threads';
import { MODEL, ModelType, MODEL_PROVIDERS, WORKER_STATUS } from '../../../constants';
import { fetchAvailableModels } from 'src/utils/fetchAvailableModels';

interface WorkerData {
  modelId: string;
  globalStoragePath: string;
  modelType: ModelType;
}

const { modelId, modelType } = workerData as WorkerData;

async function checkAndDownloadModel(): Promise<void> {
  try {
    const provider = MODEL_PROVIDERS.find((e)=> e.MODEL_PROVIDER === MODEL.OLLAMA);
    const baseURL = provider?.BASE_URL ?? "";
    // First check if the model exists
    const availableModels = await fetchAvailableModels(baseURL, "DUMMY_API_KEY");
    let modelExists = availableModels?.some(
      (model) => !model.id.includes('embed')
    );
    if (modelType === 'embedding') {
      modelExists = availableModels?.some((model) =>
        model.id.includes('embed')
      );
    }
    // if (modelExists && false) {
    if (modelExists) {
      parentPort?.postMessage({
        type: WORKER_STATUS.COMPLETED,
        message: 'Model already exists',
        models: availableModels,
      });
      return;
    }

    // Pull the model using Ollama
    const response = await fetch(`http://localhost:11434/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelId }),
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
      const lines = text.split('\n');
      for (const line of lines) {
        if (line.trim()) {
          // Ensure the line is not empty
          const progress = JSON.parse(line);

          if (
            progress.status.includes('pulling') &&
            progress.completed &&
            progress.total
          ) {
            const downloadedSize = (progress.completed / 1024 / 1024).toFixed(
              2
            );
            const totalSize = (progress.total / 1024 / 1024).toFixed(2);
            const percentage = (
              (progress.completed / progress.total) *
              100
            ).toFixed(1);

            parentPort?.postMessage({
              type: WORKER_STATUS.PROCESSING,
              progress: percentage,
              current: `${downloadedSize} MB`,
              total: `${totalSize} MB`,
              modelId: modelId,
              modelType: modelType,
            });
          }
        }
      }
    }

    // Fetch updated model list after download
    const updatedModels = await fetchAvailableModels(baseURL, "DUMMY_API_KEY");

    parentPort?.postMessage({
      type: WORKER_STATUS.COMPLETED,
      message: 'Model initialization completed successfully',
      models: updatedModels,
    });
  } catch (error) {
    parentPort?.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

// Start processing
checkAndDownloadModel();
