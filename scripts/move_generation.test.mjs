import assert from 'node:assert/strict';
import test from 'node:test';
import { createBoard, cloneBoard, placeStone, makeMove, unmakeMove, getWinnerAfterMove } from '../src/lib/game/ai/board.ts';
import { generateAllMoves, generateTacticalMoves, generateImmediateResponses, generateReinforceMoves, generateRiftMoves } from '../src/lib/game/ai/moveGen.ts';
import { getSingleStoneWinningSquares } from '../src/lib/game/ai/threats.ts';

// Standalone generators do not share parent scans. Recompute full-board threats
// after every candidate to also check that child probes never reuse parent data.
function uncachedMoves(board, player, match) {
  const responses = generateImmediateResponses(board, player, match);
  const ordinary = responses?.length ? responses : [
    ...generateReinforceMoves(board, player, match),
    ...generateRiftMoves(board, player, match),
  ].sort((a, b) => b.score - a.score);
  if (responses !== null) return { all: ordinary, tactical: responses };
  const defending = getSingleStoneWinningSquares(board, 3 - player, 'ignoreKo').length > 0;
  let pairs = 0;
  const tactical = ordinary.filter(({ move }) => {
    const undo = makeMove(board, move, player);
    const winner = getWinnerAfterMove(board, move, player);
    const forcing = winner === player || (winner === null && (
      getSingleStoneWinningSquares(board, player, 'ignoreKo').length > 0 ||
      (defending && getSingleStoneWinningSquares(board, 3 - player).length === 0)
    ));
    unmakeMove(board, undo, player);
    return forcing;
  }).filter(({ move }) => move.action === 'rift' || ++pairs <= 12);
  return { all: ordinary, tactical };
}

test('shared parent scans preserve ordered moves, scores, Ko and mutable-board probes', () => {
  const fixtures = [
    { black: [96, 112, 128], white: [98, 126] },
    { black: [105, 106, 107, 108], white: [135, 136, 137, 138], ko: 109 },
    { black: [75, 76, 78, 79, 80, 81], white: [150, 151, 152, 153, 154, 156] },
    {
      black: [66, 83, 99, 109, 110, 111, 112, 129, 130, 143, 144, 145],
      white: [50, 82, 95, 96, 97, 98, 108, 113, 114, 115, 126, 128], ko: 94,
    },
  ];
  const matches = [undefined,
    { scores: { black: 0, white: 0 }, scoreToWin: 0 },
    { scores: { black: 0, white: 0 }, scoreToWin: 3 },
    { scores: { black: 1, white: 2 }, scoreToWin: 3 },
  ];
  for (const [sample, fixture] of fixtures.entries()) {
    const board = createBoard();
    for (const pos of fixture.black) placeStone(board, pos, 1);
    for (const pos of fixture.white) placeStone(board, pos, 2);
    board.koPosition = fixture.ko ?? null;
    // A second call sees a different position even if a probe left its hash alone.
    for (const removed of [false, true]) {
      if (removed) board.cells[fixture.black[0]] = 0;
      for (const player of [1, 2]) for (const match of matches) {
        const before = cloneBoard(board);
        const expected = uncachedMoves(board, player, match);
        const context = JSON.stringify({ sample, removed, player, match });
        assert.deepEqual(generateAllMoves(board, player, match), expected.all, context);
        assert.deepEqual(generateTacticalMoves(board, player, match), expected.tactical, context);
        assert.deepEqual(board, before, context);
      }
    }
  }
});
