// Bundle before measuring, as the application does. Development-loader timings
// can differ substantially from bundled worker timings; do not mix the two.
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, relative, isAbsolute, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const project = fileURLToPath(new URL('..', import.meta.url));
let root = project;
const rootIndex = args.indexOf('--root');
if (rootIndex >= 0) {
  const value = args[rootIndex + 1];
  if (!value || value.startsWith('--')) throw new Error('--root requires a source checkout path');
  root = resolve(value);
  args.splice(rootIndex, 2);
}
const require = createRequire(import.meta.url);
const { build } = require(require.resolve('esbuild', { paths: [require.resolve('tsx')] }));
const directory = await mkdtemp(resolve(tmpdir(), 'grr-benchmark-'));
try {
  const outfile = resolve(directory, 'benchmark.mjs');
  const engineDirectory = resolve(project, 'src/lib/game/ai');
  await build({ entryPoints: [resolve(project, 'scripts/run_puzzles.ts')],
    bundle: true, platform: 'node', format: 'esm', outfile,
    // Always use the current fixtures and cold-cache methodology, even when
    // benchmarking an old engine whose original harness retained warm TT data.
    plugins: [{ name: 'reference-engine', setup(builder) {
      if (root === project) return;
      builder.onResolve({ filter: /^\.{1,2}\// }, args => {
        const path = resolve(dirname(args.importer), args.path);
        const local = relative(engineDirectory, path);
        if (local.startsWith('..') || isAbsolute(local)) return;
        const module = extname(local) ? local : `${local}.ts`;
        if (module === 'benchmark.ts' || module === 'puzzles.ts') return;
        return { path: resolve(root, 'src/lib/game/ai', module) };
      });
    } }],
  });
  const result = spawnSync(process.execPath, [outfile, '--benchmark', '--benchClean', ...args], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
