import { build, context } from 'esbuild';
import { cp, rm, mkdir } from 'node:fs/promises';

const watch = process.argv.includes('--watch');

const options = {
  entryPoints: {
    background: 'src/background.js',
    popup: 'src/ui/popup.js',
    dashboard: 'src/ui/dashboard.js',
    options: 'src/ui/options.js',
  },
  outdir: 'dist',
  bundle: true,
  format: 'esm',
  target: 'chrome116',
  // MV3 forbids remote code and eval; keep the output readable for store review.
  minify: false,
  sourcemap: watch ? 'inline' : false,
  logLevel: 'info',
};

async function copyStatic() {
  await cp('public', 'dist', { recursive: true });
  await cp('src/ui/styles.css', 'dist/styles.css');
}

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  await copyStatic();
  console.log('watching…');
} else {
  await build(options);
  await copyStatic();
  console.log('built dist/');
}
