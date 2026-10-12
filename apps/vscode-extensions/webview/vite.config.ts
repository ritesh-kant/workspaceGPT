import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// The dev loop (`vite build --watch`) keeps readable output with inline sourcemaps; every
// one-shot build (release, vsix, desktop) is minified without them — the inline map was
// 4.4 of the 6.1 MB bundle. Set WGPT_WEBVIEW_SOURCEMAP=1 to debug a one-shot build.
const dev = process.argv.includes('--watch');
const sourcemap = dev || process.env.WGPT_WEBVIEW_SOURCEMAP === '1';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: sourcemap ? 'inline' : false,
    minify: dev ? false : 'esbuild',
    assetsDir: 'assets',
    rollupOptions: {
      input: path.resolve(__dirname, 'index.html'),
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]'
      }
    },
    terserOptions: {
      compress: {
        drop_console: true
      }
    }
  },
  base: './' // This is important for VS Code webviews
});