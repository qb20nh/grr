import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';

import type { Board, Color, Move, ScoredMove } from '../../src/lib/game/ai/types';
import { BLACK, WHITE, createBoard, generateAllMoves, getOpponent, getWinnerAfterMove, makeMove, findBestMove } from '../../src/lib/game/ai/index';
import type { NnueWeights } from '../../src/lib/game/ai/nnue/weights';
import { decodeNnueWeights } from '../../src/lib/game/ai/nnue/weights';

import { XorShift32 } from './rng';

type Winner = 'A' | 'B' | 'draw';

interface MatchplayArgs {
  a: string;
  b: string;
  out: string;
  games: number;
  seed: number;
  timeMs: number;
  maxDepth: number;
  maxPlies: number;
  openingPlies: number;
  openingTopK: number;
  progressEvery: number;
  shards: number;
  shardIndex: number | null;
}

function parseArgs(argv: string[]): MatchplayArgs {
  const args: MatchplayArgs = {
    a: '',
    b: '',
    out: 'training/data/matchplay.json',
    games: 400,
    seed: 1,
    timeMs: 50,
    maxDepth: 8,
    maxPlies: 800,
    openingPlies: 4,
    openingTopK: 12,
    progressEvery: 10,
    shards: 1,
    shardIndex: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v == null) throw new Error(`Missing value for ${a}`);
      i++;
      return v;
    };

    if (a === '--a') args.a = next();
    else if (a === '--b') args.b = next();
    else if (a === '--out') args.out = next();
    else if (a === '--games') args.games = Number.parseInt(next(), 10);
    else if (a === '--seed') args.seed = Number.parseInt(next(), 10);
    else if (a === '--timeMs') args.timeMs = Number.parseInt(next(), 10);
    else if (a === '--maxDepth') args.maxDepth = Number.parseInt(next(), 10);
    else if (a === '--maxPlies') args.maxPlies = Number.parseInt(next(), 10);
    else if (a === '--openingPlies') args.openingPlies = Number.parseInt(next(), 10);
    else if (a === '--openingTopK') args.openingTopK = Number.parseInt(next(), 10);
    else if (a === '--progressEvery') args.progressEvery = Number.parseInt(next(), 10);
    else if (a === '--shards') args.shards = Number.parseInt(next(), 10);
    else if (a === '--shardIndex') args.shardIndex = Number.parseInt(next(), 10);
    else if (a === '--help' || a === '-h') {
      // eslint-disable-next-line no-console
      console.log(`
Match-play harness (A vs B)

Usage:
  node training/dist/selfplay/matchplay.mjs --a A.bin --b B.bin --out out.json [args]

Args:
  --games N
  --seed N
  --timeMs N
  --maxDepth N
  --maxPlies N
  --openingPlies N
  --openingTopK N
  --progressEvery N
  --shards N
  --shardIndex N
`);
      // eslint-disable-next-line no-process-exit
      process.exit(0);
    } else {
      throw new Error(`Unknown arg: ${a}`);
    }
  }

  if (!args.a) throw new Error('--a is required');
  if (!args.b) throw new Error('--b is required');
  if (args.games <= 0) throw new Error('--games must be > 0');
  if (args.timeMs < 0) throw new Error('--timeMs must be >= 0');
  if (args.maxDepth <= 0) throw new Error('--maxDepth must be > 0');
  if (args.maxPlies <= 0) throw new Error('--maxPlies must be > 0');
  if (args.openingPlies < 0) throw new Error('--openingPlies must be >= 0');
  if (args.openingTopK <= 0) throw new Error('--openingTopK must be > 0');
  if (args.progressEvery <= 0) throw new Error('--progressEvery must be > 0');
  if (args.shards <= 0) throw new Error('--shards must be > 0');
  if (args.shardIndex !== null) {
    if (args.shardIndex < 0) throw new Error('--shardIndex must be >= 0');
    if (args.shardIndex >= args.shards) throw new Error('--shardIndex must be < --shards');
  }

  return args;
}

async function runShard(shardArgs: MatchplayArgs, shardOut: string, shardIndex: number): Promise<void> {
  const script = process.argv[1] === 'run' ? process.argv[2] : process.argv[1];
  if (!script) throw new Error('Cannot determine script path');

  const argv: string[] = [
    script,
    '--a',
    shardArgs.a,
    '--b',
    shardArgs.b,
    '--out',
    shardOut,
    '--games',
    String(shardArgs.games),
    '--seed',
    String(shardArgs.seed),
    '--timeMs',
    String(shardArgs.timeMs),
    '--maxDepth',
    String(shardArgs.maxDepth),
    '--maxPlies',
    String(shardArgs.maxPlies),
    '--openingPlies',
    String(shardArgs.openingPlies),
    '--openingTopK',
    String(shardArgs.openingTopK),
    '--progressEvery',
    String(shardArgs.progressEvery),
    '--shards',
    String(shardArgs.shards),
    '--shardIndex',
    String(shardIndex),
  ];

  await mkdir(dirname(shardOut), { recursive: true });

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, argv, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code: number | null) => {
      if (code === 0) resolve();
      else reject(new Error(`Shard ${shardIndex} exited with code ${code}`));
    });
  });
}

async function mergeShards(finalArgs: MatchplayArgs, shardOuts: string[]): Promise<void> {
  let winsA = 0;
  let winsB = 0;
  let draws = 0;
  const perGame: { i: number; aIsBlack: boolean; winner: Winner; plies: number; seed: number }[] = [];

  for (const p of shardOuts) {
    const raw = new TextDecoder().decode(await readFile(p));
    const j = JSON.parse(raw);
    winsA += Number(j?.results?.winsA ?? 0);
    winsB += Number(j?.results?.winsB ?? 0);
    draws += Number(j?.results?.draws ?? 0);
    if (Array.isArray(j?.perGame)) {
      for (const g of j.perGame) {
        perGame.push(g);
      }
    }
  }

  perGame.sort((x, y) => (x.i ?? 0) - (y.i ?? 0));

  const out = {
    a: finalArgs.a,
    b: finalArgs.b,
    games: finalArgs.games,
    seed: finalArgs.seed,
    settings: {
      timeMs: finalArgs.timeMs,
      maxDepth: finalArgs.maxDepth,
      maxPlies: finalArgs.maxPlies,
      openingPlies: finalArgs.openingPlies,
      openingTopK: finalArgs.openingTopK,
      shards: finalArgs.shards,
    },
    results: { winsA, winsB, draws },
    perGame,
  };

  await mkdir(dirname(finalArgs.out), { recursive: true });
  await writeFile(finalArgs.out, new TextEncoder().encode(JSON.stringify(out, null, 2) + '\n'));

  for (const p of shardOuts) {
    try {
      await unlink(p);
    } catch {
      // ignore
    }
  }
}

async function loadWeights(path: string): Promise<NnueWeights> {
  const buf = await readFile(path);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  return decodeNnueWeights(ab);
}

function pickOpeningMove(rng: XorShift32, moves: ScoredMove[], topK: number): Move {
  const k = Math.min(Math.max(1, topK), moves.length);
  return moves[rng.int(0, k)].move;
}

function playGame(
  rng: XorShift32,
  weightsA: NnueWeights,
  weightsB: NnueWeights,
  aIsBlack: boolean,
  timeMs: number,
  maxDepth: number,
  maxPlies: number,
  openingPlies: number,
  openingTopK: number
): { winner: Winner; plies: number } {
  const board = createBoard();
  let player: Color = BLACK;

  for (let ply = 0; ply < maxPlies; ply++) {
    const move = (() => {
      if (ply < openingPlies) {
        const moves = generateAllMoves(board, player);
        return pickOpeningMove(rng, moves, openingTopK);
      }

      const aToMove = (player === BLACK) === aIsBlack;
      const w = aToMove ? weightsA : weightsB;
      const r = findBestMove(board, player, timeMs, maxDepth, w);
      if (!r.move) throw new Error('search returned null move');
      return r.move;
    })();

    makeMove(board, move, player);
    const winnerColor = getWinnerAfterMove(board, move, player);
    if (winnerColor) {
      const aWon = (winnerColor === BLACK) === aIsBlack;
      return { winner: aWon ? 'A' : 'B', plies: ply + 1 };
    }

    player = getOpponent(player);
  }

  return { winner: 'draw', plies: maxPlies };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.shards > 1 && args.shardIndex === null) {
    // Orchestrator mode: run shards in parallel and merge results.
    // eslint-disable-next-line no-console
    console.log('[matchplay] orchestrator', { shards: args.shards, games: args.games, out: args.out });
    const shardOuts: string[] = [];
    const shardPromises: Promise<void>[] = [];
    for (let s = 0; s < args.shards; s++) {
      const out = `${args.out}.part${s}.json`;
      shardOuts.push(out);
      shardPromises.push(runShard(args, out, s));
    }
    await Promise.all(shardPromises);
    await mergeShards(args, shardOuts);
    // eslint-disable-next-line no-console
    console.log('[matchplay] done', { out: args.out, shards: args.shards });
    return;
  }

  const shardIndex = args.shardIndex ?? 0;
  const rng = new XorShift32((args.seed * 0x9e3779b9 + shardIndex) >>> 0);

  const [weightsA, weightsB] = await Promise.all([loadWeights(args.a), loadWeights(args.b)]);

  let winsA = 0;
  let winsB = 0;
  let draws = 0;

  const games: { i: number; aIsBlack: boolean; winner: Winner; plies: number; seed: number }[] = [];

  const startedAt = Date.now();
  // eslint-disable-next-line no-console
  console.log('[matchplay] start', {
    games: args.games,
    seed: args.seed,
    timeMs: args.timeMs,
    maxDepth: args.maxDepth,
    maxPlies: args.maxPlies,
    openingPlies: args.openingPlies,
    openingTopK: args.openingTopK,
    progressEvery: args.progressEvery,
    shardIndex: args.shardIndex,
    shards: args.shards,
  });

  const localTotal = Math.ceil((args.games - shardIndex) / args.shards);
  let localDone = 0;

  for (let i = shardIndex; i < args.games; i += args.shards) {
    const aIsBlack = i % 2 === 0;
    const gameSeed = (args.seed * 0x9e3779b9 + i) >>> 0;
    const gameRng = new XorShift32(gameSeed);

    const g = playGame(
      gameRng,
      weightsA,
      weightsB,
      aIsBlack,
      args.timeMs,
      args.maxDepth,
      args.maxPlies,
      args.openingPlies,
      args.openingTopK
    );

    if (g.winner === 'A') winsA++;
    else if (g.winner === 'B') winsB++;
    else draws++;

    games.push({ i, aIsBlack, winner: g.winner, plies: g.plies, seed: gameSeed });

    localDone++;
    if (localDone % args.progressEvery === 0 || localDone === localTotal) {
      const elapsedSec = (Date.now() - startedAt) / 1000;
      const perGame = elapsedSec / localDone;
      const etaSec = perGame * (localTotal - localDone);
      // eslint-disable-next-line no-console
      console.log('[matchplay] progress', {
        done: localDone,
        total: localTotal,
        winsA,
        winsB,
        draws,
        elapsedSec: Number(elapsedSec.toFixed(1)),
        etaSec: Number(etaSec.toFixed(1)),
        shardIndex: args.shardIndex,
        shards: args.shards,
      });
    }
  }

  const out = {
    a: args.a,
    b: args.b,
    games: args.games,
    seed: args.seed,
    settings: {
      timeMs: args.timeMs,
      maxDepth: args.maxDepth,
      maxPlies: args.maxPlies,
      openingPlies: args.openingPlies,
      openingTopK: args.openingTopK,
      shards: args.shards,
    },
    results: { winsA, winsB, draws },
    perGame: games,
    shard: args.shardIndex === null ? null : { index: args.shardIndex, shards: args.shards, games: localTotal },
  };

  await mkdir(dirname(args.out), { recursive: true });
  await writeFile(args.out, new TextEncoder().encode(JSON.stringify(out, null, 2) + '\n'));
  // eslint-disable-next-line no-console
  console.log('[matchplay] done', { out: args.out, winsA, winsB, draws, games: args.games });
}

void main();

