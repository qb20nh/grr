import assert from 'node:assert/strict';
import test from 'node:test';
import { UltraCoordinator } from '../src/lib/game/ai/ultraV2/UltraCoordinator.ts';
import { createSharedTranspositionTableBacking } from '../src/lib/game/ai/transposition.ts';
import { CONFIG } from '../src/lib/game/ai/constants.ts';

test('Ultra selects completed full-root analyses by depth while preserving proven wins', async () => {
  const originalWorker = globalThis.Worker;
  let results;
  class WorkerStub extends EventTarget {
    postMessage(message) {
      const data = message.type === 'initSharedTT' ? { type: 'ultraV2Ready' } : {
        type: 'ultraV2Result', requestId: message.requestId,
        ...results[message.workerIndex],
      };
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data })));
    }
    terminate() {}
  }
  globalThis.Worker = WorkerStub;
  const coordinator = new UltraCoordinator();
  // Use a small real shared backing; workers are stubbed only at their message boundary.
  coordinator.sharedBacking = createSharedTranspositionTableBacking(16);
  const a = { move: { action: 'rift', pos: 111 }, completed: true, nodes: 10 };
  const b = { move: { action: 'rift', pos: 113 }, completed: true, nodes: 20 };
  try {
    for (const [first, second, expected] of [
      [{ ...a, score: 700000, depth: 2 }, { ...b, score: -4000, depth: 6 }, b.move],
      [{ ...a, score: 700000, depth: 0 }, { ...b, score: -4000, depth: 1 }, b.move],
      [{ ...a, score: 700000, depth: 4 }, { ...b, score: -4000, depth: 4 }, a.move],
      [{ ...a, score: CONFIG.WIN_SCORE, depth: 0 }, { ...b, score: 700000, depth: 6 }, a.move],
      [{ ...a, score: CONFIG.WIN_SCORE - 7, depth: 8 }, { ...b, score: CONFIG.WIN_SCORE - 3, depth: 4 }, b.move],
      [{ ...a, score: CONFIG.WIN_SCORE, depth: 8, completed: false }, { ...b, score: -4000, depth: 4 }, b.move],
    ]) {
      results = [first, second];
      const result = await coordinator.search({}, { workerCount: 2, maxDepth: 10, deadlineMs: Date.now() + 1000 });
      assert.deepEqual(result.best.move, expected);
      assert.equal(result.totalNodes, 30);
    }
  } finally {
    coordinator.terminate();
    globalThis.Worker = originalWorker;
  }
});
