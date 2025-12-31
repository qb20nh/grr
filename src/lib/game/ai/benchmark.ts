/**
 * Lightweight nodes/sec benchmark for the alpha-beta search.
 *
 * Goal: provide a repeatable before/after measurement in the browser worker.
 * This is NOT a unit test; tactical correctness is gated separately by puzzles.
 */

import type { Board, Color } from './types';
import { BLACK, WHITE } from './types';
import { boardFrom2D } from './board';
import { iterativeDeepening, getSearchStats } from './search';

export interface NpsBenchmarkConfig {
  /** Time budget per position (ms). */
  timeLimitMs: number;
  /** Search max depth. */
  maxDepth: number;
  /** Repeat each position this many times (averaged). */
  iterations: number;
}

export interface NpsBenchmarkCase {
  name: string;
  toMove: Color;
  board: (string | null)[][];
  ko?: { row: number; col: number } | null;
}

export interface NpsBenchmarkCaseResult {
  name: string;
  iterations: number;
  totalNodes: number;
  totalSearchMs: number;
  avgDepth: number;
  nodesPerSecond: number;
}

export interface NpsBenchmarkSummary {
  config: NpsBenchmarkConfig;
  cases: NpsBenchmarkCaseResult[];
  totalNodes: number;
  totalSearchMs: number;
  totalNodesPerSecond: number;
}

function emptyGrid(): (string | null)[][] {
  return Array.from({ length: 15 }, () => Array.from({ length: 15 }, () => null));
}

function place(grid: (string | null)[][], color: 'black' | 'white', row: number, col: number): void {
  grid[row][col] = color;
}

function toKoIndex(ko: { row: number; col: number } | null | undefined): number | null {
  if (!ko) return null;
  return ko.row * 15 + ko.col;
}

function buildBoard(c: NpsBenchmarkCase): Board {
  return boardFrom2D(c.board, toKoIndex(c.ko ?? null));
}

function getDefaultCases(): NpsBenchmarkCase[] {
  // Keep this small and stable; the goal is consistency, not exhaustive coverage.
  return [
    {
      name: 'opening_center_cluster',
      toMove: BLACK,
      board: (() => {
        const g = emptyGrid();
        place(g, 'black', 7, 7);
        place(g, 'white', 7, 8);
        place(g, 'black', 8, 7);
        place(g, 'white', 6, 8);
        place(g, 'black', 6, 6);
        place(g, 'white', 8, 8);
        return g;
      })(),
    },
    {
      name: 'midgame_tactical_forkish',
      toMove: BLACK,
      board: (() => {
        const g = emptyGrid();
        // Two distant threats, similar to the regression suite.
        place(g, 'white', 5, 0);
        place(g, 'white', 5, 1);
        place(g, 'white', 5, 2);
        place(g, 'white', 5, 3);

        place(g, 'white', 9, 11);
        place(g, 'white', 9, 12);
        place(g, 'white', 9, 13);
        place(g, 'white', 9, 14);

        place(g, 'black', 7, 7);
        place(g, 'black', 6, 8);
        place(g, 'black', 8, 6);
        return g;
      })(),
    },
    {
      name: 'ko_edge_defense',
      toMove: BLACK,
      ko: { row: 7, col: 4 },
      board: (() => {
        const g = emptyGrid();
        place(g, 'white', 7, 5);
        place(g, 'white', 7, 6);
        place(g, 'white', 7, 7);
        place(g, 'white', 7, 8);
        place(g, 'black', 6, 6);
        place(g, 'black', 8, 8);
        return g;
      })(),
    },
    {
      name: 'dense_midgame_cluster',
      toMove: WHITE,
      board: (() => {
        const g = emptyGrid();
        // Deterministic “dense” region near center.
        const stones: Array<[string, number, number]> = [
          ['black', 7, 7],
          ['white', 7, 6],
          ['black', 6, 7],
          ['white', 8, 7],
          ['black', 6, 6],
          ['white', 8, 8],
          ['black', 7, 8],
          ['white', 7, 9],
          ['black', 6, 9],
          ['white', 8, 6],
          ['black', 9, 7],
          ['white', 5, 7],
        ];
        for (const [c, r, col] of stones) {
          place(g, c as 'black' | 'white', r, col);
        }
        return g;
      })(),
    },
  ];
}

export function runNpsBenchmark(partial?: Partial<NpsBenchmarkConfig>): NpsBenchmarkSummary {
  const config: NpsBenchmarkConfig = {
    timeLimitMs: Math.max(10, Math.floor(partial?.timeLimitMs ?? 200)),
    maxDepth: Math.max(1, Math.floor(partial?.maxDepth ?? 10)),
    iterations: Math.max(1, Math.floor(partial?.iterations ?? 3)),
  };

  const cases = getDefaultCases();
  const results: NpsBenchmarkCaseResult[] = [];

  let totalNodes = 0;
  let totalSearchMs = 0;

  for (const c of cases) {
    let sumNodes = 0;
    let sumMs = 0;
    let sumDepth = 0;

    // Warm-up once (JIT, caches). Do not count.
    {
      const b = buildBoard(c);
      iterativeDeepening(b, c.toMove, Math.min(50, config.timeLimitMs), Math.min(6, config.maxDepth), {
        preserveMoveOrdering: true,
        nnueWeights: null,
      });
    }

    for (let i = 0; i < config.iterations; i++) {
      const b = buildBoard(c);
      const res = iterativeDeepening(b, c.toMove, config.timeLimitMs, config.maxDepth, {
        preserveMoveOrdering: true,
        nnueWeights: null,
      });
      const stats = getSearchStats();

      const nodes = stats.nodes;
      const ms = Math.max(1, stats.time);
      sumNodes += nodes;
      sumMs += ms;
      sumDepth += res.depth ?? 0;
    }

    totalNodes += sumNodes;
    totalSearchMs += sumMs;

    results.push({
      name: c.name,
      iterations: config.iterations,
      totalNodes: sumNodes,
      totalSearchMs: sumMs,
      avgDepth: sumDepth / config.iterations,
      nodesPerSecond: Math.round((sumNodes * 1000) / Math.max(1, sumMs)),
    });
  }

  return {
    config,
    cases: results,
    totalNodes,
    totalSearchMs,
    totalNodesPerSecond: Math.round((totalNodes * 1000) / Math.max(1, totalSearchMs)),
  };
}

