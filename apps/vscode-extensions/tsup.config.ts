import { defineConfig } from 'tsup';

export default defineConfig({
  tsconfig: './tsconfig.json',
  entry: [
    'src/extension.ts',
    'src/workers/modelWorker.ts',
    'src/workers/searchWorker.ts',
    'src/workers/embeddingWorker.ts',
    'src/workers/confluenceWorker.ts',
    'src/workers/modelDownloader.ts'
  ],
  format: ['cjs'],
  platform: 'node',
  splitting: false,
  outDir: 'dist',
  clean: true,
  external: [
    'vscode',
    '@workspace-gpt/confluence-utils',
    'hnswlib-node'
  ],
  noExternal: [
    '@xenova/transformers',
    'markdown-it'
  ],
  dts: true,
  treeshake: true,
  minify: process.env.NODE_ENV === 'production',
  sourcemap: true
});