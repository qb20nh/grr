import assert from 'node:assert/strict';
import test from 'node:test';
import { boardFrom2D, cloneBoard, makeMove, applyScoringAndClear, validateReinforce } from '../src/lib/game/ai/board.ts';
import { generateAllMoves } from '../src/lib/game/ai/moveGen.ts';
import { orderMoves, clearMoveOrdering, updateHistory, updateKillerMoves } from '../src/lib/game/ai/moveOrder.ts';
import { alphaBetaWindowed, createSearchSession, iterativeDeepening } from '../src/lib/game/ai/search.ts';
import { TranspositionTable } from '../src/lib/game/ai/transposition.ts';
import { CONFIG } from '../src/lib/game/ai/constants.ts';
import { withTurn } from '../src/lib/game/ai/zobrist.ts';
import { movesEqual } from '../src/lib/game/ai/utils.ts';

function board(stones) {
  const grid = Array.from({ length: 15 }, () => Array(15).fill(null));
  for (const [side, row, col] of stones) grid[row][col] = side === 1 ? 'black' : 'white';
  return boardFrom2D(grid);
}

test('reused candidates refresh ordering bonuses without changing base scores or tie order', () => {
  clearMoveOrdering();
  const b = board([[1,7,7], [2,9,9]]);
  const match = { scores: { black: 0, white: 0 }, scoreToWin: 3 };
  const candidates = generateAllMoves(b, 1, match);
  const original = structuredClone(candidates);
  const hints = [candidates.at(-1).move, candidates[1].move, null];
  updateHistory(candidates[2].move, 4);
  updateKillerMoves(0, candidates[3].move);
  for (const hint of hints) {
    const expected = orderMoves(b, 1, 0, hint, null, match);
    assert.deepEqual(orderMoves(b, 1, 0, hint, null, match, candidates), expected);
    assert.deepEqual(candidates, original);
  }
  clearMoveOrdering();
});

test('root reuse retains remote filtered fallbacks and refreshes a pondering position', () => {
  clearMoveOrdering();
  const b = board([[1,7,7], [2,9,9]]);
  const far = { action: 'reinforce', pos1: 0, pos2: 223 };
  assert.equal(validateReinforce(b, far.pos1, far.pos2, 1), true);
  assert.equal(generateAllMoves(b, 1).some(m => movesEqual(m.move, far)), false);
  class LeafTable extends TranspositionTable {
    tryGetScore(_hash, _depth, _alpha, _beta, ply) {
      return ply > 0 ? [true, 0, null] : [false, 0, null];
    }
  }
  const filter = move => movesEqual(move, far);
  const result = iterativeDeepening(b, 1, 0, 2, { tt: new LeafTable(16), rootMoveFilter: filter });
  assert.equal(result.depth, 2);
  assert.deepEqual(result.move, far);

  const session = createSearchSession(b, 1, 1, new LeafTable(16));
  const child = cloneBoard(b);
  makeMove(child, session.getBest().move, 1);
  session.setPosition(child, 2, null, null, null, { black: 1, white: 0 }, 3);
  const expected = generateAllMoves(child, 2, { scores: { black: 1, white: 0 }, scoreToWin: 3 })[0].move;
  assert.deepEqual(session.getBest().move, expected);
  const resumed = session.searchSlice(0);
  assert.ok(generateAllMoves(child, 2, { scores: { black: 1, white: 0 }, scoreToWin: 3 })
    .some(m => movesEqual(m.move, resumed.move)));
});

test('score keys follow scoring clears and restore the original points before quiet siblings', () => {
  const b = board([[1,7,3], [1,7,4], [1,7,5], [1,7,6], [2,2,2]]);
  const before = cloneBoard(b);
  const match = { scores: { black: 0, white: 0 }, scoreToWin: 3 };
  const candidates = generateAllMoves(b, 1, match);
  const scoring = candidates.find(({ move }) => move.action === 'reinforce' && move.pos2 === null).move;
  const quiet = candidates.find(({ move }) => {
    const copy = cloneBoard(b);
    makeMove(copy, move, 1);
    return applyScoringAndClear(copy, move, 1).points === 0;
  }).move;
  class KeyTable extends TranspositionTable {
    entries = [];
    tryGetScore(hash, _depth, _alpha, _beta, ply) {
      if (ply === 1) {
        this.entries.push({ stones: b.blackCount, scoreKey: hash ^ withTurn(b.hash, 2) });
        return [true, 0, null];
      }
      return [false, 0, null];
    }
  }
  const run = (blackScore, filter) => {
    clearMoveOrdering();
    const tt = new KeyTable(16);
    const result = alphaBetaWindowed(b, 1, 1, -CONFIG.INFINITY, CONFIG.INFINITY, 5000,
      tt, null, null, filter, null, null, { black: blackScore, white: 0 }, 3);
    assert.equal(result.completed, true);
    assert.deepEqual(b, before);
    return tt.entries;
  };
  const quietOnly = move => movesEqual(move, quiet);
  const zeroKey = run(0, quietOnly)[0].scoreKey;
  const oneKey = run(1, quietOnly)[0].scoreKey;
  assert.notEqual(zeroKey, oneKey);
  const both = run(0, move => movesEqual(move, scoring) || movesEqual(move, quiet));
  assert.equal(both.length, 2);
  assert.equal(both[0].stones, 0, 'search the scoring single before the quiet sibling');
  assert.equal(both[0].scoreKey, oneKey);
  assert.equal(both[1].scoreKey, zeroKey);
});
