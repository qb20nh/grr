import assert from 'node:assert/strict';
import test from 'node:test';
import { boardFrom2D, cloneBoard, makeMove, unmakeMove, applyScoringAndClear, validateReinforce, placeStone, checkWinAt } from '../src/lib/game/ai/board.ts';
import { alphaBetaWindowed, iterativeDeepening, findBestMove } from '../src/lib/game/ai/search.ts';
import { TranspositionTable } from '../src/lib/game/ai/transposition.ts';
import { NnueState } from '../src/lib/game/ai/nnue/evaluator.ts';
import { featureIndex } from '../src/lib/game/ai/nnue/features.ts';
import { CONFIG } from '../src/lib/game/ai/constants.ts';
import { clearMoveOrdering } from '../src/lib/game/ai/moveOrder.ts';
import { createReinforceScorer, evaluateReinforceMove } from '../src/lib/game/ai/synergy.ts';
import { getBlockingMask, getSingleStoneWinningSquares } from '../src/lib/game/ai/threats.ts';
import { evaluateSearch, evaluateHandcrafted } from '../src/lib/game/ai/evaluate.ts';

function board(stones) {
  const grid = Array.from({ length: 15 }, () => Array(15).fill(null));
  for (const [color, row, col] of stones) grid[row][col] = color === 1 ? 'black' : 'white';
  return boardFrom2D(grid);
}

function weights() {
  return {
    version: 1, boardSize: 15, featureCount: 450, hiddenDim: 1,
    outputScale: 1000, phaseWeight: 0, stmWeight: 0, outputBias: 0,
    hiddenBias: Int16Array.of(200), inputWeights: new Int8Array(450), outputWeights: Int8Array.of(1),
  };
}

function search(b, { depth = 1, alpha = -CONFIG.INFINITY, beta = CONFIG.INFINITY,
  net = null, filter = null, tt = new TranspositionTable(4096), target = 1 } = {}) {
  clearMoveOrdering();
  return alphaBetaWindowed(b, 1, depth, alpha, beta, 5000, tt, net, null, filter, null, null,
    { black: 0, white: 0 }, target);
}

test('PVS fail-low bounds never replace the best root move as an equal score', () => {
  const b = board([[1, 7, 7], [2, 9, 9]]);
  const good = { action: 'reinforce', pos1: 96, pos2: 127 };
  const bad = { action: 'reinforce', pos1: 97, pos2: 126 };
  const net = weights();
  net.inputWeights[featureIndex(good.pos1, 1)] = 100;
  net.inputWeights[featureIndex(good.pos2, 1)] = 100;
  net.inputWeights[featureIndex(bad.pos1, 1)] = -90;
  net.inputWeights[featureIndex(bad.pos2, 1)] = -90;
  const matches = (a, b) => a.action === b.action &&
    ((a.pos1 === b.pos1 && a.pos2 === b.pos2) || (a.pos1 === b.pos2 && a.pos2 === b.pos1));
  const originalRandom = Math.random;
  try {
    Math.random = () => 0; // Force the old reservoir sampler to expose the false tie.
    const result = search(b, { net, filter: m => matches(m, good) || matches(m, bad), target: 3 });
    assert.equal(result.completed, true);
    assert.ok(matches(result.move, good), JSON.stringify(result));
  } finally {
    Math.random = originalRandom;
  }
});

test('single scoring moves exclude a gap that would join four stones into an overline', () => {
  const b = board([[1,7,3],[1,7,4],[1,7,5],[1,7,6],[1,7,8]]);
  assert.deepEqual(getSingleStoneWinningSquares(b, 1), [107]);
});

test('large heuristic fork penalties cannot masquerade as a proven match loss', () => {
  const b = board([]);
  for (const pos of [53,83,86,100,139,140,155,156,168]) placeStone(b, pos, 1);
  for (const pos of [49,55,63,69,80,81,85,95,96,97,108,113,115,123,128,143,145,159,171,175,176]) placeStone(b, pos, 2);
  assert.ok(evaluateHandcrafted(b, 1) < CONFIG.LOSS_SCORE);
  assert.equal(evaluateSearch(b, 1, null), -CONFIG.MAX_STATIC_SCORE);
});

test('winning-square scanner agrees with exhaustive exact-five checks, including edges and ko', () => {
  let state = 57421;
  for (let sample = 0; sample < 100; sample++) {
    const b = board([]);
    for (let pos = 0; pos < 225; pos++) {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
      const value = (state >>> 0) % 5;
      if (value < 2) placeStone(b, pos, value + 1);
    }
    b.koPosition = sample * 11 % 225;
    const before = cloneBoard(b);
    for (const color of [1, 2]) for (const mode of ['respectKo', 'ignoreKo']) {
      const expected = [];
      for (let pos = 0; pos < 225; pos++) {
        if (b.cells[pos] || (mode === 'respectKo' && b.koPosition === pos)) continue;
        b.cells[pos] = color;
        if (checkWinAt(b, pos, color)) expected.push(pos);
        b.cells[pos] = 0;
      }
      assert.deepEqual(getSingleStoneWinningSquares(b, color, mode).sort((a,b) => a-b), expected);
    }
    assert.deepEqual(b, before);
  }
});

test('NNUE uses the board after scoring clears stones, and restores it on undo', () => {
  const b = board([[1, 7, 3], [1, 7, 4], [1, 7, 5], [1, 7, 6], [2, 2, 2]]);
  const before = cloneBoard(b);
  const move = { action: 'reinforce', pos1: 112, pos2: null, isWinningMove: true };
  const net = weights();
  for (let pos = 0; pos < 225; pos++) net.inputWeights[featureIndex(pos, 1)] = 15;
  const child = cloneBoard(b);
  makeMove(child, move, 1);
  const scoring = applyScoringAndClear(child, move, 1);
  assert.equal(scoring.points, 1);
  const expected = Math.round(NnueState.fromBoard(child, net).evaluateValue(child, 1) * CONFIG.NNUE_VALUE_SCALE)
    + Math.floor(CONFIG.WIN_SCORE / 12);
  const result = search(b, { net, filter: m => m.action === 'reinforce' && m.pos1 === 112 && m.pos2 === null, target: 3 });
  assert.equal(result.completed, true);
  assert.equal(result.score, expected);
  assert.deepEqual(b, before);
});

test('root filters do not share cached scores or return another filter\'s move', () => {
  const b = board([[1, 7, 7], [2, 9, 9]]);
  const tt = new TranspositionTable(4096);
  const first = m => m.action === 'rift';
  const second = m => m.action === 'reinforce';
  assert.equal(search(b, { filter: first, tt }).move.action, 'rift');
  const result = search(b, { filter: second, tt });
  assert.equal(result.completed, true);
  assert.equal(result.move.action, 'reinforce');
});

test('quiescence cannot stand pat instead of answering an immediate scoring threat', () => {
  const b = board([[2,7,5],[2,7,6],[2,7,7],[2,7,8],[1,5,5],[1,9,9]]);
  const net = weights();
  net.hiddenBias[0] = 20;
  for (let i = 0; i < 225; i++) {
    net.inputWeights[featureIndex(i, 1)] = -100;
    net.inputWeights[featureIndex(i, 2)] = 25;
  }
  net.inputWeights[featureIndex(80, 1)] = 0;
  net.inputWeights[featureIndex(144, 1)] = 0;
  const before = cloneBoard(b);
  const result = search(b, { depth: 0, alpha: -CONFIG.INFINITY, beta: 30000, net });
  assert.equal(result.completed, true);
  assert.ok(result.score < 30000, JSON.stringify(result));
  assert.deepEqual(b, before);
});

test('short searches deepen a defensive hint instead of returning it with unused time', () => {
  const b = board([[2,7,0],[2,7,1],[2,7,2],[2,7,3],[1,5,5],[1,9,9]]);
  const result = findBestMove(b, 1, 200, 1, null, null, null, null, {black:0,white:0}, 1,
    { tt: new TranspositionTable(4096), preserveMoveOrdering: false });
  assert.equal(result.depth, 1, JSON.stringify(result));
});

test('tactical frontier terminates and completes depth one without rift extension cycles', () => {
  const b = board([[1,7,7],[2,7,6],[1,6,7],[2,8,7],[1,6,6],[2,8,8],
    [1,7,8],[2,7,9],[1,6,9],[2,8,6],[1,9,7],[2,5,7]]);
  const before = cloneBoard(b);
  const result = iterativeDeepening(b, 2, 2000, 1, { tt: new TranspositionTable(4096) });
  assert.equal(result.depth, 1, JSON.stringify(result));
  assert.deepEqual(b, before);
});

test('cached pair scores equal independent full evaluation for legal pairs including shields and ko', () => {
  let state = 92741;
  const random = n => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) % n;
  };
  let checked = 0;
  for (let sample = 0; sample < 20; sample++) {
    const b = board([]);
    for (let i = 0; i < 12 + sample * 3; i++) {
      const pos = random(225);
      if (!b.cells[pos]) placeStone(b, pos, random(2) + 1);
    }
    b.koPosition = random(225);
    const before = cloneBoard(b);
    for (const color of [1, 2]) {
      const blocking = getBlockingMask(b, color);
      const scorer = createReinforceScorer(b, color, blocking);
      for (let a = 0; a < 225; a += 3) {
        for (let z = a + 1; z < 225; z += 5) {
          if (!validateReinforce(b, a, z, color)) continue;
          assert.equal(scorer.pair(a, z), evaluateReinforceMove(b, a, z, color, blocking),
            `sample=${sample}, color=${color}, pair=${a},${z}`);
          checked++;
        }
      }
    }
    assert.deepEqual(b, before);
  }
  assert.ok(checked > 20000, `checked ${checked} legal pairs`);
});

test('NNUE incremental state matches full reconstruction through scoring and undo', () => {
  const cases = [
    { stones: [[1,7,3],[1,7,4],[1,7,5],[1,7,6]], move: { action:'reinforce', pos1:112, pos2:null, isWinningMove:true } },
    { stones: [[1,7,3],[1,7,4],[1,7,5],[1,7,6]], move: { action:'reinforce', pos1:112, pos2:95 } },
    { stones: [[2,7,3],[2,7,4],[2,7,5],[2,7,6],[2,7,7],[2,7,8]], move: { action:'rift', pos:108 } },
    { stones: [[1,7,3],[1,7,4],[1,7,5],[1,7,6],[1,3,7],[1,4,7],[1,5,7],[1,6,7]],
      move: { action:'reinforce', pos1:112, pos2:null, isWinningMove:true } },
  ];
  const net = weights();
  for (let i = 0; i < net.inputWeights.length; i++) net.inputWeights[i] = i % 17 - 8;
  for (const { stones, move } of cases) {
    const b = board(stones);
    const before = cloneBoard(b);
    const nnue = NnueState.fromBoard(b, net);
    const undo = makeMove(b, move, 1);
    nnue.applyMove(move, 1, undo);
    const scoring = applyScoringAndClear(b, move, 1);
    assert.ok(scoring.points > 0);
    nnue.removeStones(scoring.cleared, scoring.scoredBy);
    for (const color of [1, 2]) {
      assert.equal(nnue.evaluateValue(b, color), NnueState.fromBoard(b, net).evaluateValue(b, color));
    }
    for (const pos of scoring.cleared) placeStone(b, pos, scoring.scoredBy);
    nnue.restoreStones(scoring.cleared, scoring.scoredBy);
    nnue.unapplyMove(move, 1, undo);
    unmakeMove(b, undo, 1);
    assert.deepEqual(b, before);
    assert.equal(nnue.evaluateValue(b, 1), NnueState.fromBoard(before, net).evaluateValue(before, 1));
  }
});
