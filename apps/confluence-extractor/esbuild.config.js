import * as esbuild from 'esbuild'

const config = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  outfile: 'dist/index.js',
  format: 'esm',
  packages: 'external',
  external: ['@workspace-gpt/confluence-utils'],
  sourcemap: true,
}

const isWatch = process.argv.includes('--watch')

if (isWatch) {
  // Watch mode
  const ctx = await esbuild.context(config)
  await ctx.watch()
  console.log('Watching...')
} else {
  // Single build
  esbuild.build(config).catch(() => process.exit(1))
} 