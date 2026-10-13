// Same-work move-generation timing and paired, color-swapped engine matches.
// node --import tsx scripts/compare_ai.mjs --reference ../grr-baseline --games 16 --time 100
// --unique-openings uses a distinct exact starting board for each color-swapped pair.
// --fresh-engines requires --bundle and runs each game in a new worker, clearing all engine caches.
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { getOpeningRootMoveFilter } from '../src/lib/game/ai/openingFilters.ts';
import { isRiftAllowedAtMoveIndex } from '../src/lib/game/riftRules.ts';

const { values } = parseArgs({ options: {
  reference: { type: 'string' }, games: { type: 'string', default: '16' },
  time: { type: 'string', default: '100' }, plies: { type: 'string', default: '80' },
  bundle: { type: 'boolean', default: false }, 'require-identical': { type: 'boolean', default: false },
  target: { type: 'string', default: '1' }, seed: { type: 'string', default: '101' },
  opening: { type: 'string', default: 'tactical' },
  'book-width': { type: 'string', default: '12' },
  'unique-openings': { type: 'boolean', default: false },
  'fresh-engines': { type: 'boolean', default: false },
  illegal: { type: 'string', default: 'forfeit' }, trace: { type: 'string' },
} });
assert.ok(values.reference, '--reference must point to an existing source checkout');
const games = Number(values.games), time = Number(values.time), maxPlies = Number(values.plies);
const target = Number(values.target), startSeed = Number(values.seed);
const bookWidth = Number(values['book-width']);
assert.ok(Number.isInteger(games) && games >= 0 && games % 2 === 0, 'games must be a nonnegative even integer');
assert.ok(Number.isFinite(time) && time > 0 && Number.isInteger(maxPlies) && maxPlies > 0);
assert.ok(Number.isInteger(target) && target > 0 && Number.isInteger(startSeed));
assert.ok(Number.isInteger(bookWidth) && bookWidth > 0, 'book-width must be a positive integer');
assert.ok(['tactical', 'quiet', 'long-pro', 'long-pro-book', 'long-pro-full'].includes(values.opening));
assert.ok(['forfeit', 'fallback'].includes(values.illegal));
assert.ok(!values['fresh-engines'] || values.bundle, '--fresh-engines requires --bundle');
assert.ok(!values['unique-openings'] || values.opening !== 'long-pro-full' || games <= 2,
  '--unique-openings permits at most 2 games with long-pro-full, which has only one starting board');
assert.ok(!values['unique-openings'] || values.opening !== 'long-pro-book' || games / 2 <= bookWidth,
  '--unique-openings needs at least one book-width entry per color-swapped pair');
const longPro = values.opening.startsWith('long-pro');
const openingPlies = values.opening === 'long-pro-full' ? 1 : values.opening === 'long-pro-book' ? 2 : longPro ? 3 : 6;
function openingFilter(index) {
  if (!longPro) return null;
  const placement = getOpeningRootMoveFilter('long-pro', index, index % 2 + 1);
  if (isRiftAllowedAtMoveIndex('long-pro', index)) return placement;
  return move => move.action !== 'rift' && (!placement || placement(move));
}
let bundleIndex = 0;
async function engine(root, temporary, build) {
  if (temporary) {
    const outfile = resolve(temporary, `engine-${bundleIndex++}.mjs`);
    await build({ stdin: {
      contents: ['board', 'search', 'moveGen', 'moveOrder', 'transposition'].map(p => `export * from './${p}';`).join('\n'),
      resolveDir: resolve(root, 'src/lib/game/ai'), loader: 'ts',
    }, bundle: true, platform: 'node', format: 'esm', outfile });
    const url = pathToFileURL(outfile).href;
    return { exports: await import(url), url };
  }
  const load = path => import(pathToFileURL(resolve(root, 'src/lib/game/ai', path)).href);
  return { exports: Object.assign({}, ...await Promise.all(['board.ts','search.ts','moveGen.ts','moveOrder.ts','transposition.ts'].map(load))) };
}
function reset(e) { e.clearTranspositionTable(); e.clearMoveOrdering(); }
function opening(current, reference, seed) {
  const b = current.createBoard();
  const random = n => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) % n;
  };
  let side = 1;
  for (let ply = 0; ply < openingPlies; ply++) {
    if (longPro && ply === 0) {
      current.placeStone(b, 112, 1); side = 2; continue;
    }
    if (values.opening === 'quiet' || (values.opening === 'long-pro' && ply === 2)) {
      let found = false;
      for (let attempt = 0; attempt < 10000; attempt++) {
        const a = (4 + random(7)) * 15 + 4 + random(7);
        const c = (4 + random(7)) * 15 + 4 + random(7);
        if (values.opening === 'long-pro' && [a,c].some(p => Math.abs(Math.floor(p / 15) - 7) + Math.abs(p % 15 - 7) < 3)) continue;
        if (!current.validateReinforce(b, a, c, side)) continue;
        const move = { action: 'reinforce', pos1: a, pos2: c };
        const undo = current.makeMove(b, move, side);
        if (current.getWinnerAfterMove(b, move, side) === null) { found = true; break; }
        current.unmakeMove(b, undo, side);
      }
      assert.ok(found, 'could not generate a legal nonterminal opening within 10000 attempts');
      side = 3 - side;
      continue;
    }
    // Keep openings fixed while the candidate changes during an experiment.
    const moves = reference.generateAllMoves(b, side).filter(m => !longPro || m.move.action !== 'rift');
    const offset = random(Math.min(values.opening === 'long-pro-book' ? bookWidth : 12, moves.length));
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
function benchmark(current, reference) {
  const positions = [11,29,53,97].map(seed => opening(current, reference, seed));
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
}
function legal(current, b, move, side, filter = null) {
  if (!move) return false;
  if (filter && !filter(move)) return false;
  if (move.action === 'rift') return current.validateRift(b, move.pos, side);
  if (move.pos2 !== null) return current.validateReinforce(b, move.pos1, move.pos2, side);
  if (!current.isValidPlacement(b, move.pos1)) return false;
  const undo = current.makeMove(b, move, side);
  const wins = current.checkWinAt(b, move.pos1, side);
  current.unmakeMove(b, undo, side);
  return wins;
}
function playGame(current, reference, game, seed, b) {
  reset(current); reset(reference);
  const currentColor = game % 2 + 1;
  const seen = new Map();
  const scores = { black: 0, white: 0 };
  const history = [];
  const initial = { cells: [...b.cells], ko: b.koPosition };
  let repairedMoves = 0;
  const repairedByEngine = { current: 0, reference: 0 };
  let winner = null, reason = 'ply-limit', ply = 0;
  for (; ply < maxPlies; ply++) {
    const moveIndex = ply + openingPlies;
    const side = moveIndex % 2 + 1;
    const rootFilter = openingFilter(moveIndex);
    const key = `${b.hash}:${side}:${scores.black}:${scores.white}`;
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count >= 3) { reason = 'repetition'; break; }
    const e = side === currentColor ? current : reference;
    const before = current.cloneBoard(b);
    const started = performance.now();
    const result = e.findBestMove(b, side, time, 10, null, rootFilter,
      openingFilter(moveIndex + 1), openingFilter(moveIndex + 2), scores, target);
    const elapsedMs = performance.now() - started;
    assert.deepEqual(b, before, 'search must restore board state');
    let move = result.move;
    let repaired = false;
    if (!legal(current, b, move, side, rootFilter) && values.illegal === 'forfeit') {
      winner = side === currentColor ? 'reference' : 'current';
      reason = 'illegal-move'; ply++; break;
    }
    if (!legal(current, b, move, side, rootFilter) && values.illegal === 'fallback') {
      // Match the application's legality guard rather than awarding a forfeit.
      move = e.generateAllMoves(b, side, { scores, scoreToWin: target }).find(m => legal(current, b, m.move, side, rootFilter))?.move;
      repairedMoves++;
      repairedByEngine[side === currentColor ? 'current' : 'reference']++;
      repaired = true;
    }
    assert.ok(move, 'engine must return a move in these nonterminal positions');
    if (rootFilter) assert.ok(rootFilter(move), 'opening constraints must be respected');
    if (move.action === 'rift') assert.equal(current.validateRift(b, move.pos, side), true);
    else if (move.pos2 !== null) assert.equal(current.validateReinforce(b, move.pos1, move.pos2, side), true);
    else assert.equal(current.isValidPlacement(b, move.pos1), true);
    history.push({ moveIndex, side, engine: side === currentColor ? 'current' : 'reference', move, returnedMove: result.move, repaired,
      score: result.score, depth: result.depth, nodes: result.nodes, elapsedMs, scores: {...scores} });
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
  return { result: { seed, currentColor, winner, reason, plies: ply, scores, repairedMoves, repairedByEngine }, initial, history };
}
function playFreshGame(workerPath, currentUrl, referenceUrl, game, seed, board) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, {
      argv: process.argv.slice(2),
      workerData: { currentUrl, referenceUrl, game, seed, board },
    });
    let completed;
    worker.once('message', result => { completed = result; });
    worker.once('error', reject);
    // Wait for exit so only one game's engines remain allocated at a time.
    worker.once('exit', code => {
      if (code === 0 && completed) resolve(completed);
      else reject(new Error(`match worker exited with code ${code} without a completed game`));
    });
  });
}
async function main() {
  const temporary = values.bundle ? await mkdtemp(resolve(tmpdir(), 'grr-compare-')) : null;
  try {
    const require = createRequire(import.meta.url);
    const build = temporary ? require(require.resolve('esbuild', { paths: [require.resolve('tsx')] })).build : null;
    const loadedCurrent = await engine(fileURLToPath(new URL('..', import.meta.url)), temporary, build);
    const loadedReference = await engine(values.reference, temporary, build);
    const workerPath = values['fresh-engines'] ? resolve(temporary, 'match-worker.mjs') : null;
    if (workerPath) {
      // Bundle the harness too: TypeScript loader hooks do not propagate to every Node worker version.
      await build({ entryPoints: [fileURLToPath(import.meta.url)], bundle: true, platform: 'node', format: 'esm', outfile: workerPath });
    }
    const current = loadedCurrent.exports, reference = loadedReference.exports;
    const pairs = [];
    const distinctBoards = new Set();
    let nextSeed = startSeed;
    for (let pair = 0; pair < games / 2; pair++) {
      let selected;
      for (let attempt = 0; attempt < 1000; attempt++) {
        const seed = nextSeed;
        nextSeed += 97;
        const board = opening(current, reference, seed);
        // Compare exact state instead of relying on a collision-prone board hash.
        const key = `${board.cells.join(',')}:${board.koPosition}`;
        if (values['unique-openings'] && distinctBoards.has(key)) continue;
        distinctBoards.add(key);
        selected = { seed, board };
        break;
      }
      assert.ok(selected, `could not find a distinct opening for pair ${pair + 1} within 1000 attempts; reduce games or widen the opening book`);
      pairs.push(selected);
    }
    benchmark(current, reference);
    const results = [];
    for (let game = 0; game < games; game++) {
      const { seed, board } = pairs[Math.floor(game / 2)];
      const played = values['fresh-engines']
        ? await playFreshGame(workerPath, loadedCurrent.url, loadedReference.url, game, seed, board)
        : playGame(current, reference, game, seed, current.cloneBoard(board));
      results.push(played.result);
      console.log(JSON.stringify({ game: game + 1, ...played.result }));
      if (values.trace) await writeFile(`${values.trace}-${game + 1}.json`, JSON.stringify({ ...played.result, initial: played.initial, history: played.history }));
    }
    console.log(JSON.stringify({ matchSummary: {
      games, timeMs: time, maxPlies, target, startSeed, bundled: values.bundle,
      distinctStartingBoards: distinctBoards.size,
      uniqueOpenings: values['unique-openings'], freshEngines: values['fresh-engines'],
      bookWidth: values.opening === 'long-pro-book' ? bookWidth : undefined,
      opening: values.opening === 'long-pro-full' ? 'long-pro from forced center; both engines choose all subsequent moves; identical start per pair' :
        values.opening === 'long-pro-book' ? 'long-pro with seeded White first pair; engines choose restricted Black second move; colors swapped per seed' :
        values.opening === 'long-pro' ? 'long-pro, three seeded legal opening plies; colors swapped per seed' :
        `standard-empty, six ${values.opening} opening plies; colors swapped per seed`,
      illegalPolicy: values.illegal,
      currentWins: results.filter(r => r.winner === 'current').length,
      referenceWins: results.filter(r => r.winner === 'reference').length,
      draws: results.filter(r => r.winner === null).length,
      illegalMoveForfeits: results.filter(r => r.reason === 'illegal-move' || r.reason === 'illegal-scoring-single').length,
      results,
    } }));
  } finally {
    if (temporary) await rm(temporary, { recursive: true });
  }
}
if (isMainThread) {
  await main();
} else {
  const { currentUrl, referenceUrl, game, seed, board } = workerData;
  const current = await import(currentUrl), reference = await import(referenceUrl);
  parentPort.postMessage(playGame(current, reference, game, seed, board));
}
