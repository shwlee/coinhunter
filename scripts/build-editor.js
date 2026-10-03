import { build } from 'esbuild';
await build({
  entryPoints: ['src/web/code-editor.js'],
  bundle: true,
  format: 'esm',
  outfile: 'public/generated/code-editor.js',
  minify: true,
  legalComments: 'eof',
  target: ['es2020'],
});
