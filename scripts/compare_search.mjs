// Compare identical, completed search work; run timed matches separately.
// node scripts/compare_search.mjs --reference ../grr-pr2-base --rounds 5
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { values } = parseArgs({ options: {
  reference: { type: 'string' }, rounds: { type: 'string', default: '5' },
} });
assert.ok(values.reference, '--reference requires a source checkout');
const rounds = Number(values.rounds);
assert.ok(Number.isInteger(rounds) && rounds > 0);
const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const { build } = require(require.resolve('esbuild', { paths: [require.resolve('tsx')] }));
const temporary = await mkdtemp(resolve(tmpdir(), 'grr-search-comparison-'));
async function engine(directory, name) {
  const outfile = resolve(temporary, `${name}.mjs`);
  await build({ stdin: {
    contents: ['board', 'search', 'moveOrder', 'transposition', 'openingFilters']
      .map(module => `export * from './${module}';`).join('\n'),
    resolveDir: resolve(directory, 'src/lib/game/ai'), loader: 'ts',
  }, bundle: true, platform: 'node', format: 'esm', tsconfigRaw: {}, outfile });
  return import(pathToFileURL(outfile).href);
}
const fixtures = [
  { name: 'opening_center_cluster', black: [112,127,96], white: [113,98,128] },
  { name: 'midgame_tactical_forkish', black: [112,98,126], white: [75,76,77,78,146,147,148,149] },
  { name: 'ko_edge_defense', black: [96,128], white: [110,111,112,113], ko: 109 },
  { name: 'dense_midgame_cluster', black: [112,97,96,113,99,142], white: [111,127,128,114,126,82], player: 2 },
  { name: 'multipoint_scoring', black: [108,109,110,111], white: [32,48,128], target: 3, scores: {black: 1, white: 0} },
  { name: 'long_pro_restricted', black: [112], white: [97,113], openingIndex: 2 },
];
const median = numbers => [...numbers].sort((a, b) => a - b)[Math.floor(numbers.length / 2)];
try {
  const engines = { current: await engine(root, 'current'), reference: await engine(resolve(values.reference), 'reference') };
  const results = [];
  for (const fixture of fixtures) {
    const times = { current: [], reference: [] };
    let expected;
    for (let round = -1; round < rounds; round++) {
      for (const name of round % 2 ? ['reference', 'current'] : ['current', 'reference']) {
        const e = engines[name];
        const grid = Array.from({length: 15}, () => Array(15).fill(null));
        for (const [color, stones] of [['black',fixture.black],['white',fixture.white]]) {
          for (const pos of stones) grid[Math.floor(pos / 15)][pos % 15] = color;
        }
        const board = e.boardFrom2D(grid, fixture.ko ?? null);
        const before = e.cloneBoard(board);
        const player = fixture.player ?? 1;
        const filter = fixture.openingIndex === undefined ? undefined
          : e.getOpeningRootMoveFilter('long-pro', fixture.openingIndex, player);
        e.clearTranspositionTable();
        e.clearMoveOrdering();
        const started = performance.now();
        // Zero disables the deadline and soft time manager, ensuring equal work.
        const result = e.iterativeDeepening(board, player, 0, 2, {
          rootMoveFilter: filter, scores: fixture.scores, scoreToWin: fixture.target ?? 1,
        });
        const elapsed = performance.now() - started;
        assert.equal(result.completed, true);
        assert.deepEqual(board, before, `${name}: board restoration for ${fixture.name}`);
        if (expected === undefined) expected = result;
        else assert.deepEqual(result, expected, `${name}: move/value/depth/node parity for ${fixture.name}`);
        if (round >= 0) times[name].push(elapsed);
      }
    }
    results.push({ name: fixture.name, result: expected, timesMs: times,
      currentMedianMs: median(times.current), referenceMedianMs: median(times.reference),
      speedup: median(times.reference) / median(times.current) });
  }
  const currentMs = results.reduce((sum, result) => sum + result.currentMedianMs, 0);
  const referenceMs = results.reduce((sum, result) => sum + result.referenceMedianMs, 0);
  console.log(JSON.stringify({ node: process.version, rounds, mainDepth: 2,
    identicalSearchResults: true, results, currentMs, referenceMs, speedup: referenceMs / currentMs }, null, 2));
} finally {
  await rm(temporary, {recursive: true, force: true});
}
