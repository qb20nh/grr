import assert from 'node:assert/strict';
import test from 'node:test';
import { get } from 'svelte/store';
import { createEmptyBoard } from '../src/lib/game/types.ts';
import { validateReinforceAction } from '../src/lib/game/validator.ts';
import { gameEngine } from '../src/lib/game/engine.ts';
import { gameStore, canConfirmMove } from '../src/lib/stores/gameStore.ts';

const scoring = { row: 7, col: 7 };
const quiet = { row: 10, col: 8 };

function scoringBoard(color) {
  const board = createEmptyBoard();
  for (let col = 3; col < 7; col++) board[7][col] = color;
  return board;
}

function startPosition(color, board = scoringBoard(color)) {
  gameStore.startGame('local', 3, 'standard-empty');
  if (color === 'white') gameStore.switchPlayer();
  const state = gameStore.getState();
  for (let row = 0; row < 15; row++) state.board[row] = [...board[row]];
  return gameEngine;
}

for (const color of ['black', 'white']) {
  test(`${color}: scoring reinforces reject an extra stone in either order`, () => {
    const board = scoringBoard(color);
    const before = structuredClone(board);
    for (const positions of [[scoring, quiet], [quiet, scoring]]) {
      const result = validateReinforceAction(board, positions, color, null);
      assert.equal(result.valid, false);
      assert.match(result.reason, /scoring.*one stone/i);
    }
    assert.equal(validateReinforceAction(board, [scoring], color, null).valid, true);
    assert.equal(validateReinforceAction(board, [scoring], color, scoring).valid, false);
    assert.deepEqual(board, before);
  });

  test(`${color}: human selection and hints reject a scoring pair in either order`, () => {
    for (const [first, second] of [[scoring, quiet], [quiet, scoring]]) {
      const engine = startPosition(color);
      engine.handleBoardClick(first);
      assert.equal(engine.canPlaceAt(second), false);
      assert.equal(engine.getInvalidPositions().has(`${second.row},${second.col}`), true);
      engine.handleBoardClick(second);
      assert.deepEqual(gameStore.getState().pendingPlacements, [first]);
      assert.equal(get(canConfirmMove), first === scoring);
      // The selected stone remains clickable so it can be cancelled.
      assert.equal(engine.canPlaceAt(first), true);
      engine.handleBoardClick(first);
      assert.deepEqual(gameStore.getState().pendingPlacements, []);
    }
  });

  test(`${color}: confirming a stale scoring pair does not change the game`, t => {
    const engine = startPosition(color);
    gameStore.addPendingPlacement(scoring);
    gameStore.addPendingPlacement(quiet);
    assert.equal(get(canConfirmMove), false);
    const before = structuredClone(gameStore.getState());
    t.mock.method(console, 'warn', () => {});
    engine.confirmMove();
    assert.deepEqual(gameStore.getState(), before);
  });

  test(`${color}: one stone scores and clears multiple intersecting lines`, () => {
    const board = scoringBoard(color);
    for (let row = 3; row < 7; row++) board[row][7] = color;
    const engine = startPosition(color, board);
    engine.handleBoardClick(scoring);
    assert.equal(get(canConfirmMove), true);
    engine.confirmMove();
    const state = gameStore.getState();
    assert.equal(state.scores[color], 2);
    assert.deepEqual(state.board, createEmptyBoard());
    assert.equal(state.moveHistory.length, 1);
    assert.deepEqual(state.moveHistory[0].positions, [scoring]);
    assert.equal(state.moveHistory[0].scoredLines.length, 2);
    assert.equal(state.currentPlayer, color === 'black' ? 'white' : 'black');
  });

  test(`${color}: a non-scoring pair that makes an overline remains legal`, () => {
    const board = scoringBoard(color);
    board[7][8] = color;
    const engine = startPosition(color, board);
    engine.handleBoardClick(scoring);
    assert.equal(get(canConfirmMove), false);
    assert.equal(engine.canPlaceAt(quiet), true);
    engine.handleBoardClick(quiet);
    assert.equal(get(canConfirmMove), true);
    engine.confirmMove();
    const state = gameStore.getState();
    assert.equal(state.scores[color], 0);
    assert.equal(state.board[7][7], color);
    assert.equal(state.board[10][8], color);
    assert.deepEqual(state.moveHistory[0].positions, [scoring, quiet]);
  });

  test(`${color}: an illegal scoring pair from the AI is replaced before animation`, t => {
    const originalWorker = globalThis.Worker;
    let searchWorker;
    globalThis.Worker = class {
      postMessage(message) {
        if (message.type === 'findBestMove') searchWorker = this;
      }
      terminate() {}
    };
    t.after(() => {
      gameStore.resetGame();
      gameEngine.terminateAi();
      if (originalWorker === undefined) delete globalThis.Worker;
      else globalThis.Worker = originalWorker;
    });
    for (const method of ['log', 'warn', 'error']) t.mock.method(console, method, () => {});
    const humanColor = color === 'black' ? 'white' : 'black';
    gameStore.startGame('vs-ai', humanColor, 3, 200, 'standard-empty');
    if (color === 'white') gameStore.switchPlayer();
    const board = scoringBoard(color);
    for (let row = 0; row < 15; row++) gameStore.getState().board[row] = [...board[row]];
    gameEngine.executeAiTurn();
    assert.ok(searchWorker);
    searchWorker.onmessage({ data: { type: 'result', move: {
      action: 'reinforce', positions: [scoring, quiet]
    } } });
    const state = gameStore.getState();
    assert.equal(state.scores[color], 1);
    assert.equal(state.moveHistory.length, 1);
    assert.equal(state.moveHistory[0].positions.length, 1);
    assert.equal(state.board[quiet.row][quiet.col], null);
    assert.equal(state.aiThinking, false);
    assert.equal(state.currentPlayer, humanColor);
  });
}

test('Long Pro still permits its forced non-scoring single stone at center', () => {
  gameStore.startGame('local', 3, 'long-pro');
  const engine = gameEngine;
  engine.handleBoardClick(scoring);
  assert.equal(get(canConfirmMove), true);
  engine.confirmMove();
  assert.equal(gameStore.getState().board[7][7], 'black');
  assert.equal(gameStore.getState().scores.black, 0);
  assert.deepEqual(gameStore.getState().moveHistory[0].positions, [scoring]);
});
