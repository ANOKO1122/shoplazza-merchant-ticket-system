import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
await build({
  absWorkingDir: root,
  entryPoints: ['frontend/protection/main.tsx'],
  bundle: true,
  minify: true,
  target: ['es2020'],
  format: 'iife',
  outfile: 'public/protection/admin.js',
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'none',
});
await build({
  absWorkingDir: root,
  entryPoints: ['frontend/customer-protection/main.tsx'],
  bundle: true,
  minify: true,
  target: ['es2020'],
  format: 'iife',
  outfile: 'public/assets/customer-protection.js',
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'none',
});
