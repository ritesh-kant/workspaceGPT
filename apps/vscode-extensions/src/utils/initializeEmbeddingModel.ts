import * as path from 'path';

const importModule = new Function('modulePath', 'return import(modulePath)');
let extractor: any;

export async function initializeEmbeddingModel(embeddingModel: string, embeddingDirPath:string, progressCallback: (status: any) => void) {
    try {
      const { pipeline } = await importModule('@xenova/transformers');
      // Add model options with local_files_only set to false to allow downloading if needed
      // and add a longer timeout to handle potential network issues
      extractor = await pipeline(
        'feature-extraction',
        embeddingModel,
        {
          local_files_only: false,
          revision: 'main',
          quantized: true,
          cache_dir: path.join(embeddingDirPath, '.cache', 'transformers'),
          progress_callback: (progress: any) => {
            if (progress.status === 'progress') {
              console.log(`Confluence: Downloading model: ${progress.progress}`);
              const progressPercent = Math.round(progress.progress);
              progressCallback({
                type: progress.status,
                progress: progressPercent,
                message: `Downloading model: ${progressPercent}%`,
              });
            }
          },
        }
      );
      return extractor;
    } catch (error) {
      throw new Error(`Failed to initialize model: ${(error as Error).message}`);
    }
  }
  