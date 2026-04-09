import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node18',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  dts: false,
  splitting: false,
  // Bundle SDK and zod for standalone execution
  // Only externalize packages with native binaries
  external: ['onnxruntime-node', '@xenova/transformers'],
  noExternal: ['@modelcontextprotocol/sdk', 'zod'],
  banner: {
    js: '#!/usr/bin/env node',
  },
});
