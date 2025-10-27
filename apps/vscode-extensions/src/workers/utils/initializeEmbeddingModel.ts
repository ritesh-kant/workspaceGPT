import * as path from 'path';
import { pipeline, env } from '@xenova/transformers';

let extractor: any;

export async function initializeEmbeddingModel(embeddingModel: string, embeddingDirPath: string, progressCallback: (status: any) => void) {
    try {
      // Use pre-bundled models from the extension's models directory
      // The models are bundled during build time for offline availability
      const extensionModelsPath = path.join(__dirname, '../../models');
      
      extractor = await pipeline(
        'feature-extraction',
        embeddingModel,
        {
          local_files_only: true, // Use only local files - no downloading
          revision: 'main',
          quantized: true,
          cache_dir: extensionModelsPath, // Use bundled models directory
          progress_callback: (progress: any) => {
            if (progress.status === 'progress') {
              const progressPercent = Math.round(progress.progress);
              progressCallback({
                type: progress.status,
                progress: progressPercent,
                message: `Loading model: ${progressPercent}%`,
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
