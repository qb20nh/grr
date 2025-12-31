#!/usr/bin/env bun
/**
 * Tactical puzzle runner (Bun)
 *
 * Usage:
 *   bun scripts/run_puzzles.ts
 *   bun scripts/run_puzzles.ts --timeLimitMs 400
 *   bun scripts/run_puzzles.ts --time 400 --benchmark
 *
 * Exit codes:
 *   0 = all puzzles passed
 *   1 = any puzzle failed or an error occurred
 */

import { runTacticalPuzzles } from '../src/lib/game/ai/puzzles.ts';
import { runNpsBenchmark } from '../src/lib/game/ai/benchmark.ts';
import { clearMoveOrdering } from '../src/lib/game/ai/moveOrder.ts';
import { clearTranspositionTable } from '../src/lib/game/ai/transposition.ts';

declare const process: {
  argv: string[];
  exit(code?: number): never;
};

type ArgValue = string | boolean;
type ArgMap = Map<string, ArgValue>;

function parseArgs(argv: string[]): ArgMap {
  const out: ArgMap = new Map();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;

    const eq = a.indexOf('=');
    if (eq !== -1) {
      const k = a.slice(0, eq);
      const v = a.slice(eq + 1);
      out.set(k, v);
      continue;
    }

    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out.set(a, next);
      i++;
      continue;
    }

    out.set(a, true);
  }
  return out;
}

function getFlag(args: ArgMap, name: string): boolean {
  return args.get(name) === true;
}

function getString(args: ArgMap, name: string, fallback: string): string {
  const v = args.get(name);
  if (typeof v === 'string') return v;
  return fallback;
}

function getNumber(args: ArgMap, name: string, fallback: number): number {
  const v = args.get(name);
  if (typeof v !== 'string') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function printHelp(): void {
  console.log(`
Usage:
  bun scripts/run_puzzles.ts [options]

Options:
  --timeLimitMs <n>   Time budget per puzzle (default: 250)
  --time <n>          Alias for --timeLimitMs
  --json              Print JSON summary
  --benchmark         Also run nodes/sec benchmark (does not affect exit code)
  --benchClean        Clear TT + move ordering before running the benchmark (default: false)
  --benchTimeMs <n>   Benchmark time per position (default: 200)
  --benchDepth <n>    Benchmark max depth (default: 10)
  --benchIters <n>    Benchmark iterations (default: 3)
  --help              Show this help
`.trim());
}

function padRight(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + ' '.repeat(width - s.length);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (getFlag(args, '--help')) {
    printHelp();
    return 0;
  }

  const timeLimitMs =
    getNumber(args, '--timeLimitMs', getNumber(args, '--time', 250));
  const asJson = getFlag(args, '--json');
  const runBench = getFlag(args, '--benchmark');

  const t0 = Date.now();
  const puzzles = runTacticalPuzzles(timeLimitMs);
  const dt = Date.now() - t0;

  if (asJson) {
    console.log(JSON.stringify({ timeLimitMs, elapsedMs: dt, ...puzzles }, null, 2));
  } else {
    console.log(`Tactical puzzles (timeLimitMs=${timeLimitMs})`);
    console.log(`Passed: ${puzzles.passed}  Failed: ${puzzles.failed}  Elapsed: ${dt}ms`);

    if (puzzles.failed > 0) {
      console.log('\nFailures:');
      for (const r of puzzles.results) {
        if (r.ok) continue;
        console.log(`- ${r.name}`);
        if (r.details) console.log(`  ${r.details}`);
      }
    }
  }

  if (runBench) {
    const benchClean = getFlag(args, '--benchClean');
    const benchTimeMs = getNumber(args, '--benchTimeMs', 200);
    const benchDepth = getNumber(args, '--benchDepth', 10);
    const benchIters = getNumber(args, '--benchIters', 3);

    if (benchClean) {
      clearMoveOrdering();
      clearTranspositionTable();
    }

    const bench = runNpsBenchmark({
      timeLimitMs: benchTimeMs,
      maxDepth: benchDepth,
      iterations: benchIters,
    });

    if (asJson) {
      console.log(JSON.stringify({ benchmark: bench }, null, 2));
    } else {
      console.log('\nNPS benchmark');
      console.log(`Config: timeLimitMs=${bench.config.timeLimitMs} maxDepth=${bench.config.maxDepth} iterations=${bench.config.iterations}`);
      const nameW = Math.max(10, ...bench.cases.map(c => c.name.length));
      for (const c of bench.cases) {
        console.log(
          `${padRight(c.name, nameW)}  nps=${c.nodesPerSecond}  avgDepth=${c.avgDepth.toFixed(2)}  nodes=${c.totalNodes}  ms=${c.totalSearchMs}`
        );
      }
      console.log(`Total: nps=${bench.totalNodesPerSecond}  nodes=${bench.totalNodes}  ms=${bench.totalSearchMs}`);
    }
  }

  return puzzles.failed > 0 ? 1 : 0;
}

main()
  .then(code => {
    process.exit(code);
  })
  .catch(err => {
    console.error('[run_puzzles] Fatal error:', err);
    process.exit(1);
  });

