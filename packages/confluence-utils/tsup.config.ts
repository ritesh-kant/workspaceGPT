import { defineConfig } from 'tsup';

export default defineConfig({
  tsconfig: './tsconfig.json',
  entry: ['src/index.ts'],
  format: ['cjs'],
  platform: 'node',
  target: 'node16',
  outDir: 'dist',
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: true,
  treeshake: true,
  minify: false,
  noExternal: [
    'axios',
    'htmlparser2'
  ],
  external: [
    'puppeteer',
    'openai'
  ]
});