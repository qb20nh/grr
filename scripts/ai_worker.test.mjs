import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { boardFrom2D, makeMove, checkWinAt, validateReinforce, validateRift } from '../src/lib/game/ai/board.ts';

// Exercise the actual application worker through its message boundary. Node only
// supplies postMessage/self; this does not replace a browser integration test.
test('application worker returns legal moves for opening, scoring and ko states', { timeout: 15000 }, async () => {
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { tsImport } = require('tsx/esm/api');
    globalThis.self = globalThis;
    globalThis.postMessage = message => parentPort.postMessage(message);
    (async () => {
      await tsImport(workerData, workerData);
      parentPort.on('message', data => self.onmessage({ data }));
      parentPort.postMessage({ type: 'ready' });
    })().catch(error => { throw error; });
  `, { eval: true, workerData: new URL('../src/lib/game/ai.worker.ts', import.meta.url).href });
  try {
    assert.equal((await once(worker, 'message'))[0].type, 'ready');
    const fixtures = [
      { stones: [], color: 1, opening: 'long-pro', index: 0 },
      { stones: [[1,7,7]], color: 2, opening: 'long-pro', index: 1 },
      { stones: [[1,7,7],[2,6,6],[2,8,8]], color: 1, opening: 'long-pro', index: 2 },
      { stones: [[1,7,3],[1,7,4],[1,7,5],[1,7,6],[1,7,8]], color: 1 },
      { stones: [[2,7,0],[2,7,1],[2,7,2],[2,7,3],[1,5,5],[1,9,9]], color: 1, ko: {row:7,col:4} },
      { stones: [[1,7,3],[1,7,4],[1,7,5],[1,7,6],[2,2,2]], color: 1, target: 3 },
      // Even a mate-coded selective search must return a legal move, not resign.
      { stones: [[2,5,3],[2,5,4],[2,5,5],[2,5,6],
        [2,9,3],[2,9,4],[2,9,5],[2,9,6],[1,7,7]], color: 1 },
    ];
    for (const f of fixtures) {
      const grid = Array.from({length:15}, () => Array(15).fill(null));
      for (const [color,row,col] of f.stones) grid[row][col] = color === 1 ? 'black' : 'white';
      const response = once(worker, 'message');
      worker.postMessage({ type:'findBestMove', state: {
        board:grid, aiColor:f.color === 1 ? 'black' : 'white', lastRiftedPosition:f.ko ?? null,
        scores:{black:0,white:0}, scoreToWin:f.target ?? 1,
        openingPreset:f.opening ?? 'standard-empty', moveIndex:f.index ?? 8,
      }, config:{maxTime:200,maxDepth:2} });
      const [result] = await response;
      assert.equal(result.type, 'result');
      assert.equal(result.error, undefined, JSON.stringify(result));
      assert.equal(result.resign, undefined, JSON.stringify(result));
      assert.ok(result.move, JSON.stringify(result));
      const { action, positions } = result.move;
      const b = boardFrom2D(grid, f.ko ? f.ko.row * 15 + f.ko.col : null);
      const indices = positions.map(p => p.row * 15 + p.col);
      if (f.index === 0) assert.deepEqual(indices, [112]);
      else if (action === 'rift') assert.equal(validateRift(b, indices[0], f.color), true);
      else if (indices.length === 2) assert.equal(validateReinforce(b, indices[0], indices[1], f.color), true);
      else {
        assert.equal(indices.length, 1);
        assert.equal(b.cells[indices[0]], 0);
        assert.notEqual(indices[0], b.koPosition);
        makeMove(b, {action:'reinforce',pos1:indices[0],pos2:null,isWinningMove:true}, f.color);
        assert.equal(checkWinAt(b, indices[0], f.color), true);
      }
      if (f.index === 1) assert.equal(action, 'reinforce');
      if (f.index === 2) {
        assert.equal(action, 'reinforce');
        assert.equal(indices.length, 2);
        for (const p of positions) assert.ok(Math.abs(p.row - 7) + Math.abs(p.col - 7) >= 3);
      }
    }
  } finally {
    await worker.terminate();
  }
});
