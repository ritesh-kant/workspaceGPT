/**
 * Script to pre-download embedding models for offline use
 * This runs during the build process to ensure models are bundled with the extension
 */

import { pipeline, env } from '@xenova/transformers';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Model to download
const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';
const MODELS_DIR = path.join(__dirname, '..', 'models');

async function downloadModel() {
  try {
    console.log('📦 Starting model download...');
    console.log(`Model: ${MODEL_NAME}`);
    console.log(`Target directory: ${MODELS_DIR}`);

    // Ensure models directory exists
    if (!fs.existsSync(MODELS_DIR)) {
      fs.mkdirSync(MODELS_DIR, { recursive: true });
      console.log('✅ Created models directory');
    }

    // Set cache directory
    env.cacheDir = MODELS_DIR;

    // Download model with progress callback
    console.log('⬇️  Downloading model files...');
    const extractor = await pipeline(
      'feature-extraction',
      MODEL_NAME,
      {
        local_files_only: false,
        revision: 'main',
        quantized: true,
        cache_dir: MODELS_DIR,
        progress_callback: (progress) => {
          if (progress.status === 'progress') {
            const progressPercent = Math.round(progress.progress);
            process.stdout.write(`\r   Progress: ${progressPercent}%`);
          } else if (progress.status === 'done') {
            console.log(`\n   ✅ Downloaded: ${progress.file}`);
          } else if (progress.status === 'ready') {
            console.log(`   ✅ Ready: ${progress.task}`);
          }
        },
      }
    );

    console.log('\n✅ Model downloaded successfully!');
    console.log(`📁 Model location: ${MODELS_DIR}`);

    // List downloaded files
    console.log('\n📄 Downloaded files:');
    const listFiles = (dir, indent = '   ') => {
      if (!fs.existsSync(dir)) return;
      const files = fs.readdirSync(dir);
      files.forEach(file => {
        const filePath = path.join(dir, file);
        const stats = fs.statSync(filePath);
        if (stats.isDirectory()) {
          console.log(`${indent}📁 ${file}/`);
          listFiles(filePath, indent + '  ');
        } else {
          const sizeInMB = (stats.size / (1024 * 1024)).toFixed(2);
          console.log(`${indent}📄 ${file} (${sizeInMB} MB)`);
        }
      });
    };
    listFiles(MODELS_DIR);

    console.log('\n🎉 Model download complete!');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Error downloading model:', error);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run the download
downloadModel();
