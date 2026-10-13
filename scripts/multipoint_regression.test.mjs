import assert from 'node:assert/strict';
import test from 'node:test';
import { createBoard, placeStone, cloneBoard, checkWinAt, makeMove, applyScoringAndClear, validateReinforce } from '../src/lib/game/ai/board.ts';
import { alphaBetaWindowed } from '../src/lib/game/ai/search.ts';
import { generateImmediateResponses } from '../src/lib/game/ai/moveGen.ts';
import { TranspositionTable } from '../src/lib/game/ai/transposition.ts';
import { CONFIG } from '../src/lib/game/ai/constants.ts';
import { getImmediateMatchWinningMove } from '../src/lib/game/ai/threats.ts';

function crossingFours(side) {
  const b = createBoard();
  for (const p of [108,109,110,111,52,67,82,97]) placeStone(b, p, side);
  return b;
}

test('quiescence horizon recognizes a two-line match win', () => {
  const b = crossingFours(1);
  const before = cloneBoard(b);
  const depth = CONFIG.QUIESCENCE_DEPTH;
  try {
    CONFIG.QUIESCENCE_DEPTH = 0;
    const result = alphaBetaWindowed(b, 1, 0, -CONFIG.INFINITY, CONFIG.INFINITY,
      1000, new TranspositionTable(64), null, null, null, null, null,
      {black:0,white:0}, 2);
    assert.equal(result.score, CONFIG.WIN_SCORE - 1);
    assert.deepEqual(b, before);
  } finally {
    CONFIG.QUIESCENCE_DEPTH = depth;
  }
});

test('multi-point quiescence preserves a five-ply forcing win without the one-point prover', () => {
  // Replay the position after White's rift in the 59001 validation game.
  // A two-ply tactical frontier evaluates Black as losing instead of seeing
  // the forced final point. Multi-point games do not run the separate prover.
  const b = createBoard();
  for (const p of [50,66,82,95,97,99,110,112,124,129,141,154,175,114]) placeStone(b,p,1);
  for (const p of [81,94,96,111,125,126,127,128,130,140,142,143,144,155,156,159,168,182]) placeStone(b,p,2);
  makeMove(b,{action:'rift',pos:114},2);
  const before = cloneBoard(b);
  const result = alphaBetaWindowed(b,1,0,-CONFIG.INFINITY,CONFIG.INFINITY,
    5000,new TranspositionTable(4096),null,null,null,null,null,{black:2,white:1},3);
  assert.equal(result.completed,true);
  assert.equal(result.score,CONFIG.WIN_SCORE-5);
  assert.deepEqual(b,before);
});

test('two-line match threats trigger complete immediate defenses', () => {
  const b = crossingFours(2);
  const before = cloneBoard(b);
  const moves = generateImmediateResponses(b, 1, {scores:{black:0,white:0},scoreToWin:2});
  assert.notEqual(moves, null);
  assert.ok(moves.some(({move}) => move.action === 'rift'));
  assert.ok(moves.some(({move}) => move.action === 'reinforce' && [move.pos1,move.pos2].includes(112)));
  assert.deepEqual(b, before);
});

function actualPoints(b, move, side) {
  const after = cloneBoard(b);
  makeMove(after, move, side);
  return applyScoringAndClear(after, move, side).points;
}

function exhaustiveWinningMove(b, side, needed) {
  const squares = [];
  for (let p = 0; p < 225; p++) {
    if (b.cells[p] || b.koPosition === p || !checkWinAt(b, p, side)) continue;
    const move = {action:'reinforce',pos1:p,pos2:null};
    if (actualPoints(b, move, side) >= needed) return move;
    squares.push(p);
  }
  for (let i = 0; i < squares.length; i++) for (let j = i+1; j < squares.length; j++) {
    const a = squares[i], c = squares[j];
    if (!validateReinforce(b, a, c, side)) continue;
    const move = {action:'reinforce',pos1:a,pos2:c};
    if (actualPoints(b, move, side) >= needed) return move;
  }
  return null;
}

test('match-winning placement detection agrees with actual multi-line scoring and legal pairs', () => {
  const pair = createBoard();
  for (const p of [75,76,77,78,151,152,153,154]) placeStone(pair, p, 1);
  const collinear = createBoard();
  for (const p of [75,76,77,78,150,151,152,153]) placeStone(collinear, p, 1);
  const overline = createBoard();
  for (const p of [105,106,107,108,110]) placeStone(overline, p, 1);
  const fixtures = [crossingFours(1), crossingFours(2), pair, collinear, overline];
  const pairWin = getImmediateMatchWinningMove(pair, 1, 2);
  assert.ok(pairWin && pairWin.pos2 !== null);
  assert.equal(getImmediateMatchWinningMove(collinear, 1, 2), null);
  let state = 4897;
  for (let sample = 0; sample < 40; sample++) {
    const b = createBoard();
    for (let p = 0; p < 225; p++) {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
      const x = (state >>> 0) % (4 + sample % 5);
      if (x < 2) placeStone(b, p, x+1);
    }
    fixtures.push(b);
  }
  for (const b of fixtures) for (const ko of [null,112]) {
    b.koPosition = ko;
    const before = cloneBoard(b);
    for (const side of [1,2]) for (let needed = 1; needed <= 9; needed++) {
      const move = getImmediateMatchWinningMove(b, side, needed);
      assert.equal(move !== null, exhaustiveWinningMove(b, side, needed) !== null);
      if (move) assert.ok(actualPoints(b, move, side) >= needed);
    }
    assert.deepEqual(b, before);
  }
});

test('multi-point defenses equal exhaustive legal replies after scoring clears', () => {
  const b = crossingFours(2);
  const before = cloneBoard(b);
  const key = m => m.action === 'rift' ? `r${m.pos}` : `p${Math.min(m.pos1,m.pos2)},${Math.max(m.pos1,m.pos2)}`;
  const expected = new Set();
  const check = move => {
    const after = cloneBoard(b);
    makeMove(after, move, 1);
    const scoring = applyScoringAndClear(after, move, 1);
    const needed = 2 - (scoring.scoredBy === 2 ? scoring.points : 0);
    if (needed > 0 && exhaustiveWinningMove(after, 2, needed) === null) expected.add(key(move));
  };
  for (let a = 0; a < 225; a++) {
    if (b.cells[a] === 2) check({action:'rift',pos:a});
    for (let c = a+1; c < 225; c++) {
      if (validateReinforce(b,a,c,1)) check({action:'reinforce',pos1:a,pos2:c});
    }
  }
  assert.deepEqual(new Set(generateImmediateResponses(b,1,{scores:{black:0,white:0},scoreToWin:2}).map(m => key(m.move))), expected);
  const first = generateImmediateResponses(b,1,{scores:{black:0,white:0},scoreToWin:2},true);
  assert.equal(first.length, Math.min(1, expected.size));
  if (first.length) assert.ok(expected.has(key(first[0].move)));
  assert.deepEqual(b, before);
});
