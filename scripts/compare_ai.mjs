// Same-work move-generation timing and paired, color-swapped engine matches.
// node --import tsx scripts/compare_ai.mjs --reference ../grr-baseline --games 16 --time 100
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const { values } = parseArgs({ options: {
  reference: { type: 'string' }, games: { type: 'string', default: '16' },
  time: { type: 'string', default: '100' }, plies: { type: 'string', default: '80' },
  bundle: { type: 'boolean', default: false }, 'require-identical': { type: 'boolean', default: false },
  target: { type: 'string', default: '1' }, seed: { type: 'string', default: '101' },
  opening: { type: 'string', default: 'tactical' },
} });
assert.ok(values.reference, '--reference must point to an existing source checkout');
const games = Number(values.games), time = Number(values.time), maxPlies = Number(values.plies);
const target = Number(values.target), startSeed = Number(values.seed);
assert.ok(Number.isInteger(games) && games >= 0 && games % 2 === 0, 'games must be a nonnegative even integer');
assert.ok(Number.isFinite(time) && time > 0 && Number.isInteger(maxPlies) && maxPlies > 0);
assert.ok(Number.isInteger(target) && target > 0 && Number.isInteger(startSeed));
assert.ok(['tactical', 'quiet'].includes(values.opening));
const temporary = values.bundle ? await mkdtemp(resolve(tmpdir(), 'grr-compare-')) : null;
let bundleIndex = 0;
async function engine(root) {
  if (temporary) {
    const require = createRequire(import.meta.url);
    const { build } = require(require.resolve('esbuild', { paths: [require.resolve('tsx')] }));
    const outfile = resolve(temporary, `engine-${bundleIndex++}.mjs`);
    await build({ stdin: {
      contents: ['board', 'search', 'moveGen', 'moveOrder', 'transposition'].map(p => `export * from './${p}';`).join('\n'),
      resolveDir: resolve(root, 'src/lib/game/ai'), loader: 'ts',
    }, bundle: true, platform: 'node', format: 'esm', outfile });
    return import(pathToFileURL(outfile).href);
  }
  const load = path => import(pathToFileURL(resolve(root, 'src/lib/game/ai', path)).href);
  return Object.assign({}, ...await Promise.all(['board.ts','search.ts','moveGen.ts','moveOrder.ts','transposition.ts'].map(load)));
}
const current = await engine(fileURLToPath(new URL('..', import.meta.url)));
const reference = await engine(values.reference);
if (temporary) await rm(temporary, { recursive: true }); // imported modules remain in memory
function reset(e) { e.clearTranspositionTable(); e.clearMoveOrdering(); }
function opening(seed) {
  const b = current.createBoard();
  const random = n => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) % n;
  };
  let side = 1;
  for (let ply = 0; ply < 6; ply++) {
    if (values.opening === 'quiet') {
      for (;;) {
        const a = (4 + random(7)) * 15 + 4 + random(7);
        const c = (4 + random(7)) * 15 + 4 + random(7);
        if (!current.validateReinforce(b, a, c, side)) continue;
        const move = { action: 'reinforce', pos1: a, pos2: c };
        const undo = current.makeMove(b, move, side);
        if (current.getWinnerAfterMove(b, move, side) === null) break;
        current.unmakeMove(b, undo, side);
      }
      side = 3 - side;
      continue;
    }
    // Keep openings fixed while the candidate changes during an experiment.
    const moves = reference.generateAllMoves(b, side);
    const offset = random(Math.min(12, moves.length));
    for (let j = 0; j < moves.length; j++) {
      const move = moves[(offset + j) % moves.length].move;
      const undo = current.makeMove(b, move, side);
      if (current.getWinnerAfterMove(b, move, side) === null) break;
      current.unmakeMove(b, undo, side);
    }
    side = 3 - side;
  }
  return b;
}
const positions = [11,29,53,97].map(opening);
let identicalOutputs = true;
for (const b of positions) for (const side of [1,2]) {
  const actual = current.generateAllMoves(b, side), expected = reference.generateAllMoves(b, side);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) identicalOutputs = false;
  if (values['require-identical']) assert.deepEqual(actual, expected);
}
const timings = { current: [], reference: [] };
for (let round = -1; round < 5; round++) {
  const order = round % 2 ? ['reference','current'] : ['current','reference'];
  for (const name of order) {
    const e = name === 'current' ? current : reference;
    const start = performance.now();
    for (let repeat = 0; repeat < 50; repeat++) {
      for (const b of positions) for (const side of [1,2]) e.generateAllMoves(b, side);
    }
    if (round >= 0) timings[name].push(performance.now() - start);
  }
}
const median = a => [...a].sort((a,b) => a-b)[Math.floor(a.length/2)];
console.log(JSON.stringify({ moveGeneration: {
  callsPerRound: 400, identicalOutputs, rounds: 5, bundled: values.bundle,
  currentMs: median(timings.current), referenceMs: median(timings.reference),
  speedup: median(timings.reference) / median(timings.current),
} }));
const results = [];
for (let game = 0; game < games; game++) {
  reset(current); reset(reference);
  const seed = startSeed + Math.floor(game / 2) * 97;
  const b = opening(seed);
  const currentColor = game % 2 + 1;
  const seen = new Map();
  const scores = { black: 0, white: 0 };
  let winner = null, reason = 'ply-limit', ply = 0;
  for (; ply < maxPlies; ply++) {
    const side = ply % 2 + 1;
    const key = `${b.hash}:${side}:${scores.black}:${scores.white}`;
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count >= 3) { reason = 'repetition'; break; }
    const e = side === currentColor ? current : reference;
    const before = current.cloneBoard(b);
    const result = e.findBestMove(b, side, time, 10, null, null, null, null, scores, target);
    assert.deepEqual(b, before, 'search must restore board state');
    const move = result.move;
    assert.ok(move, 'engine must return a move in these nonterminal positions');
    if (move.action === 'rift') assert.equal(current.validateRift(b, move.pos, side), true);
    else if (move.pos2 !== null) assert.equal(current.validateReinforce(b, move.pos1, move.pos2, side), true);
    else assert.equal(current.isValidPlacement(b, move.pos1), true);
    current.makeMove(b, move, side);
    const scoring = current.applyScoringAndClear(b, move, side);
    if (move.action === 'reinforce' && move.pos2 === null && scoring.points === 0) {
      winner = side === currentColor ? 'reference' : 'current';
      reason = 'illegal-scoring-single'; ply++; break;
    }
    if (scoring.points > 0) {
      const color = scoring.scoredBy === 1 ? 'black' : 'white';
      scores[color] += scoring.points;
      if (scores[color] >= target) {
        winner = scoring.scoredBy === currentColor ? 'current' : 'reference';
        reason = 'score'; ply++; break;
      }
    }
  }
  results.push({ seed, currentColor, winner, reason, plies: ply, scores });
  console.log(JSON.stringify({ game: game + 1, ...results.at(-1) }));
}
console.log(JSON.stringify({ matchSummary: {
  games, timeMs: time, maxPlies, target, bundled: values.bundle,
  opening: `standard-empty, six ${values.opening} opening plies; colors swapped per seed`,
  currentWins: results.filter(r => r.winner === 'current').length,
  referenceWins: results.filter(r => r.winner === 'reference').length,
  draws: results.filter(r => r.winner === null).length,
  illegalMoveForfeits: results.filter(r => r.reason === 'illegal-scoring-single').length,
  results,
} }));
