import esbuild from 'esbuild';
import process from 'node:process';
import builtins from 'builtin-modules';

const prod = process.argv.includes('--prod');

// Obsidian provides `obsidian`, `electron`, the bundled CodeMirror/Lezer
// packages, and Node builtins at runtime — never bundle them.
const external = [
  'obsidian', 'electron',
  '@codemirror/autocomplete', '@codemirror/collab', '@codemirror/commands',
  '@codemirror/language', '@codemirror/lint', '@codemirror/search',
  '@codemirror/state', '@codemirror/view',
  '@lezer/common', '@lezer/highlight', '@lezer/lr',
  ...builtins, ...builtins.map((m) => `node:${m}`),
];

const ctx = await esbuild.context({
  entryPoints: { main: 'src/main.ts', styles: 'src/styles.css' },
  bundle: true,
  format: 'cjs',
  target: 'es2018',
  platform: 'browser',
  external,
  jsx: 'automatic',
  loader: { '.css': 'css' },
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  define: { 'process.env.NODE_ENV': prod ? '"production"' : '"development"' },
  outdir: '.',
  logLevel: 'info',
});

if (prod) {
  await ctx.rebuild();
  await ctx.dispose();
} else {
  await ctx.watch();
  process.stderr.write('[vault-obsidian] esbuild watching…\n');
}
