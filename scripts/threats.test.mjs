import assert from 'node:assert/strict';
import test from 'node:test';
import { createBoard } from '../src/lib/game/ai/board.ts';
import { scanLine, classifyLine } from '../src/lib/game/ai/patterns.ts';
import { getBlockingMask, getSingleStoneWinningSquares } from '../src/lib/game/ai/threats.ts';

test('winning gaps stay visible from either adjacent run, without reordering full-board wins', () => {
  for (const [origin, offset] of [[105, 1], [7, 15], [0, 16], [14, 14]]) {
    for (const line of ['10111', '11011', '11101']) {
      for (const player of [1, 2]) {
        const board = createBoard();
        for (let i = 0; i < line.length; i++) board.cells[origin + i * offset] = Number(line[i]) * player;
        const gap = origin + line.indexOf('0') * offset;
        assert.deepEqual(getSingleStoneWinningSquares(board, player), [gap]);
        for (let i = 0; i < line.length; i++) if (line[i] === '1') {
          assert.deepEqual(getSingleStoneWinningSquares(board, player, 'respectKo', [origin + i * offset]), [gap]);
        }
        board.koPosition = gap;
        assert.deepEqual(getSingleStoneWinningSquares(board, player), []);
        assert.deepEqual(getSingleStoneWinningSquares(board, player, 'ignoreKo'), [gap]);
      }
    }
  }
  const board = createBoard();
  // The first run finds its own empty endpoint and the gap to a later run.
  for (const pos of [106, 107, 108, 109, 113, 115, 116, 117]) board.cells[pos] = 1;
  assert.deepEqual(getSingleStoneWinningSquares(board, 1), [105, 110, 114]);
  assert.deepEqual(getSingleStoneWinningSquares(board, 1, 'respectKo', [117, 108]), [114, 105, 110]);
});

// Scan every stone independently so this oracle does not rely on the optimized
// assumption that all stones in a contiguous run share their blocking squares.
function blockingSquaresByStone(board, player, ignoreKo) {
  const squares = new Set();
  for (let pos = 0; pos < board.cells.length; pos++) {
    if (board.cells[pos] !== 3 - player) continue;
    for (let dir = 0; dir < 4; dir++) {
      const info = scanLine(board, pos, dir, 3 - player, ignoreKo);
      if (!['OPEN_FOUR', 'GAP_FOUR', 'HALF_FOUR', 'OPEN_THREE'].includes(classifyLine(info))) continue;
      if (info.extendCount >= 1) squares.add(info.extend1);
      if (info.extendCount >= 2) squares.add(info.extend2);
      if (info.gaps === 1) squares.add(info.gapPos);
    }
  }
  return [...squares].sort((a, b) => a - b);
}

test('blocking mask matches all-stone scans across runs, gaps, edges and Ko', () => {
  let seed = 0x517ab1e;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const boards = [];
  for (let sample = 0; sample < 240; sample++) {
    const board = createBoard();
    const density = [0.12, 0.3, 0.55, 0.8][sample % 4];
    for (let pos = 0; pos < board.cells.length; pos++) {
      if (random() < density) board.cells[pos] = random() < 0.5 ? 1 : 2;
    }
    const empty = [...board.cells.keys()].filter(pos => board.cells[pos] === 0);
    board.koPosition = empty.length ? empty[Math.floor(random() * empty.length)] : null;
    boards.push(board);
  }
  // Dense random boards need explicit long-run coverage, including overlines
  // and two competing one-gap continuations at either end of the same run.
  for (const cells of ['0111100', '1111100', '1111110', '110111011', '10111011']) {
    for (const [origin, offset] of [[105, 1], [7, 15], [0, 16], [14, 14]]) {
      const board = createBoard();
      for (let i = 0; i < cells.length; i++) board.cells[origin + i * offset] = Number(cells[i]);
      board.koPosition = origin + cells.indexOf('0') * offset;
      boards.push(board);
    }
  }
  for (const [sample, board] of boards.entries()) {
    const original = board.cells.slice();
    for (const player of [1, 2]) for (const ignoreKo of [false, true]) {
      const expected = blockingSquaresByStone(board, player, ignoreKo);
      const { mask, stamp } = getBlockingMask(board, player, ignoreKo);
      const actual = [...mask.keys()].filter(pos => mask[pos] === stamp);
      assert.deepEqual(actual, expected, `sample=${sample} player=${player} ignoreKo=${ignoreKo}`);
      assert.deepEqual(board.cells, original);
    }
  }
});
