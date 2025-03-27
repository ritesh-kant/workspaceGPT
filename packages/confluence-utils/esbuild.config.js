export default {
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  outfile: 'dist/index.js',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
  splitting: false,
  treeShaking: true
} 