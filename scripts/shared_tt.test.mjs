import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { createSharedTranspositionTableBacking } from '../src/lib/game/ai/transposition.ts';

test('shared TT never combines payloads from concurrent same-key writers', { timeout: 15000 }, async () => {
  const backing = createSharedTranspositionTableBacking(2);
  const gate = new Int32Array(new SharedArrayBuffer(4));
  const moduleUrl = new URL('../src/lib/game/ai/transposition.ts', import.meta.url).href;
  const workers = [];
  try {
    const ready = [];
    const done = [];
    for (let id = 1; id <= 4; id++) {
      const worker = new Worker(`
        const { parentPort, workerData: d } = require('node:worker_threads');
        (async () => {
          const { tsImport } = require('tsx/esm/api');
          const { TranspositionTable } = await tsImport(d.moduleUrl, d.moduleUrl);
          const tt = new TranspositionTable(d.backing);
          const gate = new Int32Array(d.gate);
          parentPort.postMessage('ready');
          Atomics.wait(gate, 0, 0);
          let bad = 0, hits = 0;
          for (let i = 0; i < 40000; i++) {
            tt.store(1n, d.id, d.id * 101, 'exact', { action: 'rift', pos: d.id });
            const entry = tt.probe(1n);
            if (entry) {
              hits++;
              if (entry.score !== entry.depth * 101 || entry.bestMove?.pos !== entry.depth) bad++;
            }
            const [hit, score, move] = tt.tryGetScore(1n, 1, -10000, 10000, 0);
            if (hit) {
              hits++;
              if (score !== move?.pos * 101) bad++;
            }
          }
          parentPort.postMessage({ bad, hits });
        })().catch(error => { throw error; });
      `, { eval: true, workerData: { id, moduleUrl, backing, gate: gate.buffer } });
      workers.push(worker);
      ready.push(new Promise((resolve, reject) => {
        worker.on('message', msg => { if (msg === 'ready') resolve(); });
        worker.once('error', reject);
      }));
      done.push(new Promise((resolve, reject) => {
        worker.on('message', msg => { if (msg !== 'ready') resolve(msg); });
        worker.once('error', reject);
      }));
    }
    const [, results] = await Promise.all([
      Promise.all(ready).then(() => {
        Atomics.store(gate, 0, 1);
        Atomics.notify(gate, 0);
      }),
      Promise.all(done),
    ]);
    assert.ok(results.reduce((n, r) => n + r.hits, 0) > 1000);
    assert.equal(results.reduce((n, r) => n + r.bad, 0), 0, JSON.stringify(results));
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
  }
});
