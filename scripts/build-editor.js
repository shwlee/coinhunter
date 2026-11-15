import { build } from 'esbuild';
await build({
  entryPoints: ['frontend/src/code-editor.js'],
  bundle: true,
  format: 'esm',
  outfile: 'frontend/public/generated/code-editor.js',
  minify: true,
  legalComments: 'eof',
  target: ['es2020'],
});
