// Same-work move-generation timing and paired, color-swapped engine matches.
// node --import tsx scripts/compare_ai.mjs --reference ../grr-baseline --games 16 --time 100
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const { values } = parseArgs({ options: {
  reference: { type: 'string' }, games: { type: 'string', default: '16' },
  time: { type: 'string', default: '100' }, plies: { type: 'string', default: '80' },
} });
assert.ok(values.reference, '--reference must point to an existing source checkout');
const games = Number(values.games), time = Number(values.time), maxPlies = Number(values.plies);
assert.ok(Number.isInteger(games) && games >= 0 && games % 2 === 0, 'games must be a nonnegative even integer');
assert.ok(Number.isFinite(time) && time > 0 && Number.isInteger(maxPlies) && maxPlies > 0);
async function engine(root) {
  const load = path => import(pathToFileURL(resolve(root, 'src/lib/game/ai', path)).href);
  return Object.assign({}, ...await Promise.all(['board.ts','search.ts','moveGen.ts','moveOrder.ts','transposition.ts'].map(load)));
}
const current = await engine(fileURLToPath(new URL('..', import.meta.url)));
const reference = await engine(values.reference);
function reset(e) { e.clearTranspositionTable(); e.clearMoveOrdering(); }
function opening(seed) {
  const b = current.createBoard();
  let side = 1;
  for (let ply = 0; ply < 6; ply++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    const moves = current.generateAllMoves(b, side);
    const offset = (seed >>> 0) % Math.min(12, moves.length);
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
for (const b of positions) for (const side of [1,2]) {
  assert.deepEqual(current.generateAllMoves(b, side), reference.generateAllMoves(b, side));
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
  callsPerRound: 400, identicalOutputs: true, rounds: 5,
  currentMs: median(timings.current), referenceMs: median(timings.reference),
  speedup: median(timings.reference) / median(timings.current),
} }));
const results = [];
for (let game = 0; game < games; game++) {
  reset(current); reset(reference);
  const seed = 101 + Math.floor(game / 2) * 97;
  const b = opening(seed);
  const currentColor = game % 2 + 1;
  const seen = new Map();
  let winner = null, reason = 'ply-limit', ply = 0;
  for (; ply < maxPlies; ply++) {
    const side = ply % 2 + 1;
    const key = `${b.hash}:${side}`;
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count >= 3) { reason = 'repetition'; break; }
    const e = side === currentColor ? current : reference;
    const before = current.cloneBoard(b);
    const result = e.findBestMove(b, side, time, 10);
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
      winner = scoring.scoredBy === currentColor ? 'current' : 'reference';
      reason = 'score'; ply++; break;
    }
  }
  results.push({ seed, currentColor, winner, reason, plies: ply });
  console.log(JSON.stringify({ game: game + 1, ...results.at(-1) }));
}
console.log(JSON.stringify({ matchSummary: {
  games, timeMs: time, maxPlies, opening: 'standard-empty, six deterministic opening plies; colors swapped per seed',
  currentWins: results.filter(r => r.winner === 'current').length,
  referenceWins: results.filter(r => r.winner === 'reference').length,
  draws: results.filter(r => r.winner === null).length,
  illegalMoveForfeits: results.filter(r => r.reason === 'illegal-scoring-single').length,
  results,
} }));
