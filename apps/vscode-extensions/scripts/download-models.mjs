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

// Keep in sync with MODEL.DEFAULT_* in constants.ts
const MODELS = [
  'Xenova/all-MiniLM-L6-v2',
  'jinaai/jina-embeddings-v2-base-code',
];
const MODELS_DIR = path.join(__dirname, '..', 'models');
const TRANSFORMERS_CACHE = path.join(
  __dirname,
  '..',
  'node_modules',
  '@xenova',
  'transformers',
  '.cache'
);

function modelOnnxPath(modelName) {
  return path.join(MODELS_DIR, ...modelName.split('/'), 'onnx', 'model_quantized.onnx');
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(from, to);
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

function seedFromTransformersCache(modelName) {
  const cachePath = path.join(TRANSFORMERS_CACHE, ...modelName.split('/'));
  const destPath = path.join(MODELS_DIR, ...modelName.split('/'));
  const cacheOnnx = path.join(cachePath, 'onnx', 'model_quantized.onnx');
  if (!fs.existsSync(cacheOnnx)) {
    return false;
  }
  console.log(`📦 Seeding ${modelName} from transformers cache…`);
  copyDir(cachePath, destPath);
  return fs.existsSync(modelOnnxPath(modelName));
}

async function ensureModel(modelName) {
  if (fs.existsSync(modelOnnxPath(modelName))) {
    console.log(`✅ Already present: ${modelName}`);
    return;
  }

  if (seedFromTransformersCache(modelName)) {
    console.log(`✅ Seeded: ${modelName}`);
    return;
  }

  console.log(`⬇️  Downloading ${modelName}…`);
  await pipeline('feature-extraction', modelName, {
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
  });
  console.log(`\n✅ Downloaded: ${modelName}`);
}

async function downloadModels() {
  try {
    console.log('📦 Starting model download…');
    console.log(`Target directory: ${MODELS_DIR}`);

    if (!fs.existsSync(MODELS_DIR)) {
      fs.mkdirSync(MODELS_DIR, { recursive: true });
    }

    env.cacheDir = MODELS_DIR;

    for (const modelName of MODELS) {
      await ensureModel(modelName);
    }

    console.log('\n📄 Bundled model files:');
    const listFiles = (dir, indent = '   ') => {
      if (!fs.existsSync(dir)) return;
      for (const file of fs.readdirSync(dir)) {
        const filePath = path.join(dir, file);
        const stats = fs.statSync(filePath);
        if (stats.isDirectory()) {
          console.log(`${indent}📁 ${file}/`);
          listFiles(filePath, indent + '  ');
        } else {
          const sizeInMB = (stats.size / (1024 * 1024)).toFixed(2);
          console.log(`${indent}📄 ${file} (${sizeInMB} MB)`);
        }
      }
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

downloadModels();
