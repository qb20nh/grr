import type { Move } from '../types';
import { CONFIG, createSharedTranspositionTableBacking } from '../index';
import type { SharedTranspositionTableBacking } from '../transposition';
import type { OpeningPreset } from '../../types';

type LegacyBoard = (string | null)[][];

export interface UltraV2WorkerState {
  board: LegacyBoard;
  playerToMove: 'black' | 'white';
  lastRiftedPosition: { row: number; col: number } | null;
  scores: { black: number; white: number };
  scoreToWin: number;
  openingPreset: OpeningPreset;
  moveIndex: number;
}

interface InitSharedTTMsg {
  type: 'initSharedTT';
  backing: SharedTranspositionTableBacking;
}

interface SearchMsg {
  type: 'search';
  requestId: number;
  workerIndex: number;
  state: UltraV2WorkerState;
  deadlineMs: number;
  maxDepth: number;
}

type Outgoing = InitSharedTTMsg | SearchMsg;

interface ReadyMsg {
  type: 'ultraV2Ready';
}

interface SearchResultMsg {
  type: 'ultraV2Result';
  requestId: number;
  completed: boolean;
  move: Move | null;
  score: number;
  depth: number;
  nodes: number;
}

type Incoming = ReadyMsg | SearchResultMsg;

function canUseSharedTT(): boolean {
  // Cross-origin isolation is required for SharedArrayBuffer (shared TT).
  if (typeof SharedArrayBuffer === 'undefined') return false;
  if (typeof Atomics === 'undefined') return false;
  return (globalThis as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
}

function waitForType(w: Worker, expectedType: string, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const onMsg = (ev: MessageEvent) => {
      const data = ev.data as Incoming;
      if (!data || typeof data !== 'object') return;
      if ((data as any).type !== expectedType) return;
      cleanup();
      resolve(true);
    };
    const onErr = () => {
      cleanup();
      resolve(false);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, Math.max(1, timeoutMs));
    const cleanup = () => {
      clearTimeout(timer);
      w.removeEventListener('message', onMsg);
      w.removeEventListener('error', onErr);
    };
    w.addEventListener('message', onMsg);
    w.addEventListener('error', onErr, { once: true });
  });
}

function waitForResult(w: Worker, requestId: number, timeoutMs: number): Promise<SearchResultMsg | null> {
  return new Promise(resolve => {
    const onMsg = (ev: MessageEvent) => {
      const data = ev.data as Incoming;
      if (!data || typeof data !== 'object') return;
      if ((data as any).type !== 'ultraV2Result') return;
      const r = data as SearchResultMsg;
      if (r.requestId !== requestId) return;
      cleanup();
      resolve(r);
    };
    const onErr = () => {
      cleanup();
      resolve(null);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, Math.max(1, timeoutMs));
    const cleanup = () => {
      clearTimeout(timer);
      w.removeEventListener('message', onMsg);
      w.removeEventListener('error', onErr);
    };
    w.addEventListener('message', onMsg);
    w.addEventListener('error', onErr, { once: true });
  });
}

function pickBetter(
  a: { move: Move; score: number; depth: number; nodes: number } | null,
  b: { move: Move; score: number; depth: number; nodes: number } | null
): { move: Move; score: number; depth: number; nodes: number } | null {
  if (!a) return b;
  if (!b) return a;
  if (b.score !== a.score) return b.score > a.score ? b : a;
  if (b.depth !== a.depth) return b.depth > a.depth ? b : a;
  return Math.random() < 0.5 ? a : b;
}

export class UltraCoordinator {
  private sharedBacking: SharedTranspositionTableBacking | null = null;
  private pool: Worker[] = [];
  private poolBacking: SharedTranspositionTableBacking | null = null;
  private nextRequestId = 1;

  terminate(): void {
    for (const w of this.pool) {
      try {
        w.terminate();
      } catch {
        // ignore
      }
    }
    this.pool = [];
    this.poolBacking = null;
  }

  private getBackingBestEffort(): SharedTranspositionTableBacking | null {
    if (this.sharedBacking) return this.sharedBacking;
    if (!canUseSharedTT()) return null;

    // Best effort: try full TT size first, then shrink until it fits.
    const maxPow = Math.floor(Math.log2(CONFIG.TT_SIZE));
    const minPow = 18; // 262k entries
    for (let pow = maxPow; pow >= minPow; pow--) {
      const size = 1 << pow;
      try {
        this.sharedBacking = createSharedTranspositionTableBacking(size);
        return this.sharedBacking;
      } catch {
        // try smaller
      }
    }
    return null;
  }

  private async ensurePool(workerCount: number, backing: SharedTranspositionTableBacking, deadlineMs: number): Promise<Worker[]> {
    // If backing changed, reset the pool so all workers attach to the same SAB.
    if (this.poolBacking !== backing) {
      this.terminate();
      this.poolBacking = backing;
    }

    const missing = Math.max(0, workerCount - this.pool.length);
    if (missing > 0) {
      // Worker module init can be slow; create in parallel and allow a generous one-time window.
      const remainingMs = deadlineMs - Date.now();
      const initTimeoutMs = Math.max(250, Math.min(10_000, remainingMs));

      const created: Worker[] = [];
      const waits: Array<Promise<boolean>> = [];

      for (let i = 0; i < missing; i++) {
        const w = new Worker(new URL('./ultraV2.worker.ts', import.meta.url), { type: 'module' });
        created.push(w);
        waits.push(waitForType(w, 'ultraV2Ready', initTimeoutMs));
        w.postMessage({ type: 'initSharedTT', backing } satisfies InitSharedTTMsg);
      }

      const oks = await Promise.all(waits);
      for (let i = 0; i < created.length; i++) {
        const w = created[i]!;
        if (oks[i]) {
          this.pool.push(w);
        } else {
          try {
            w.terminate();
          } catch {
            // ignore
          }
        }
      }
    }

    return this.pool.slice(0, Math.min(workerCount, this.pool.length));
  }

  async search(
    state: UltraV2WorkerState,
    opts: { deadlineMs: number; maxDepth: number; workerCount: number }
  ): Promise<{ best: { move: Move; score: number; depth: number; nodes: number } | null; totalNodes: number; usedSharedTT: boolean }> {
    const backing = this.getBackingBestEffort();
    if (!backing) {
      return { best: null, totalNodes: 0, usedSharedTT: false };
    }

    const workers = await this.ensurePool(opts.workerCount, backing, opts.deadlineMs);
    if (workers.length === 0) {
      this.terminate();
      return { best: null, totalNodes: 0, usedSharedTT: false };
    }

    const requestId = this.nextRequestId++;
    const graceMs = 150;
    const timeoutMs = Math.max(1, opts.deadlineMs + graceMs - Date.now());

    const waits: Array<Promise<SearchResultMsg | null>> = [];
    for (let i = 0; i < workers.length; i++) {
      const w = workers[i]!;
      waits.push(waitForResult(w, requestId, timeoutMs));
      w.postMessage({
        type: 'search',
        requestId,
        workerIndex: i,
        state,
        deadlineMs: opts.deadlineMs,
        maxDepth: opts.maxDepth,
      } satisfies SearchMsg);
    }

    const results = await Promise.allSettled(waits);

    let best: { move: Move; score: number; depth: number; nodes: number } | null = null;
    let totalNodes = 0;

    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      const msg = r.value;
      if (!msg || msg.type !== 'ultraV2Result') continue;
      totalNodes += Number.isFinite(msg.nodes) ? msg.nodes : 0;
      if (!msg.completed) continue;
      if (!msg.move) continue;
      best = pickBetter(best, { move: msg.move, score: msg.score, depth: msg.depth, nodes: msg.nodes });
    }

    return { best, totalNodes, usedSharedTT: true };
  }
}

