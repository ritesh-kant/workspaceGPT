const esbuild = require('esbuild');
const path = require('path');

const isWatch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const baseConfig = {
  entryPoints: [
    'src/extension.ts',
    'src/workers/modelWorker.ts',
    'src/workers/searchWorker.ts',
    'src/workers/embeddingWorker.ts',
    'src/workers/confluenceWorker.ts',
    'src/workers/modelDownloader.ts'
  ],
  bundle: true,
  platform: 'node',
  target: 'node18',
  outdir: 'dist',
  format: 'cjs',
  sourcemap: true,
  minify: process.env.NODE_ENV === 'production',
  external: ['vscode'],
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'development')
  },
  plugins: [{
    name: 'dynamic-import',
    setup(build) {
      // Handle dynamic imports
      build.onResolve({ filter: /^@xenova\/transformers/ }, args => {
        return { external: true, path: args.path }
      })
    }
  }]
};

if (isWatch) {
  esbuild.context(baseConfig).then(context => {
    context.watch();
  });
} else {
  esbuild.build(baseConfig).catch(() => process.exit(1));
} 