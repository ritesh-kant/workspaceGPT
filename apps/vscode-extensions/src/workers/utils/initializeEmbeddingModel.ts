import * as path from 'path';
import { pipeline, env } from '@xenova/transformers';

let extractor: any;

export async function initializeEmbeddingModel(embeddingModel: string, embeddingDirPath: string, progressCallback: (status: any) => void) {
    try {
      // Add model options with local_files_only set to false to allow downloading if needed
      // and add a longer timeout to handle potential network issues

      // env.backends.onnx.wasm.wasmPaths = path.join(__dirname, '../../../node_modules/onnxruntime-web/dist/');
      extractor = await pipeline(
        'feature-extraction',
        embeddingModel,
        {
          local_files_only: false,
          revision: 'main',
          quantized: true,
          cache_dir: path.join(embeddingDirPath, '.cache', 'transformers'),
          // Configure ONNX runtime to avoid tensor location issues
          // device: 'cpu',
          // dtype: 'fp32',
          progress_callback: (progress: any) => {
            if (progress.status === 'progress') {
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
