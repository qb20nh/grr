import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';

import type { Board, Color, Move, ScoredMove } from '../../src/lib/game/ai/types';
import {
  BLACK,
  WHITE,
  createBoard,
  generateAllMoves,
  getOpponent,
  getWinnerAfterMove,
  makeMove,
  findBestMove,
} from '../../src/lib/game/ai/index';
import type { NnueWeights } from '../../src/lib/game/ai/nnue/weights';
import { decodeNnueWeights } from '../../src/lib/game/ai/nnue/weights';

import { parseArgs, type SelfPlayOptions } from './args';
import { XorShift32 } from './rng';

type ResultFromBlack = -1 | 0 | 1;

const DATASET_MAGIC = 'GRRSP001'; // 8 bytes
const DATASET_VERSION = 1;
const HEADER_BYTES = 8 + 4 + 4; // magic + version + recordCount
const CELLS = 225;
const RECORD_BYTES = CELLS + 1 + 1; // cells + toMove + resultFromBlack

interface Snapshot {
  cells: Uint8Array; // length 225
  toMove: Color;
}

async function loadWeightsFromPath(path: string): Promise<NnueWeights | null> {
  try {
    const buf = await readFile(path);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return decodeNnueWeights(ab as ArrayBuffer);
  } catch {
    return null;
  }
}

function readU32LE(buf: Uint8Array, offset: number): number {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(offset, true);
}

async function runShard(opts: SelfPlayOptions, outPath: string, shardIndex: number): Promise<void> {
  const script = process.argv[1] === 'run' ? process.argv[2] : process.argv[1];
  if (!script) throw new Error('Cannot determine script path');

  const argv: string[] = [
    script,
    '--out',
    outPath,
    '--games',
    String(opts.games),
    '--maxPlies',
    String(opts.maxPlies),
    '--seed',
    String(opts.seed),
    '--shards',
    String(opts.shards),
    '--shardIndex',
    String(shardIndex),
    '--policy',
    String(opts.policy),
    '--topK',
    String(opts.topK),
    '--temperature',
    String(opts.temperature),
    '--epsilon',
    String(opts.epsilon),
    '--timeMs',
    String(opts.timeMs),
    '--maxDepth',
    String(opts.maxDepth),
  ];
  if (opts.weightsPath) {
    argv.push('--weights', opts.weightsPath);
  }

  await mkdir(dirname(outPath), { recursive: true });

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, argv, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code: number | null) => {
      if (code === 0) resolve();
      else reject(new Error(`Shard ${shardIndex} exited with code ${code}`));
    });
  });
}

async function mergeDatasets(partPaths: string[], outPath: string): Promise<void> {
  let totalRecords = 0;
  const parts: { payload: Uint8Array; records: number }[] = [];

  for (const p of partPaths) {
    const buf = await readFile(p);
    if (buf.byteLength < HEADER_BYTES) {
      throw new Error(`Dataset shard too small: ${p}`);
    }
    const magic = String.fromCharCode(...buf.slice(0, 8));
    if (magic !== DATASET_MAGIC) {
      throw new Error(`Dataset shard bad magic: ${p}`);
    }
    const version = readU32LE(buf, 8);
    if (version !== DATASET_VERSION) {
      throw new Error(`Dataset shard bad version: ${p}`);
    }
    const records = readU32LE(buf, 12);
    const payload = buf.slice(HEADER_BYTES);
    totalRecords += records;
    parts.push({ payload, records });
  }

  await mkdir(dirname(outPath), { recursive: true });
  const fh = await open(outPath, 'w');

  const header = new Uint8Array(HEADER_BYTES);
  for (let i = 0; i < 8; i++) header[i] = DATASET_MAGIC.charCodeAt(i) & 0xff;
  new DataView(header.buffer).setUint32(8, DATASET_VERSION, true);
  new DataView(header.buffer).setUint32(12, totalRecords, true);
  await fh.write(header, 0, header.length, 0);

  let offset = HEADER_BYTES;
  for (const part of parts) {
    await fh.write(part.payload, 0, part.payload.length, offset);
    offset += part.payload.length;
  }

  await fh.close();

  for (const p of partPaths) {
    try {
      await unlink(p);
    } catch {
      // ignore
    }
  }
}

function snapshot(board: Board, toMove: Color): Snapshot {
  return { cells: board.cells.slice(), toMove };
}

function winnerToResultFromBlack(winner: Color | null): ResultFromBlack {
  if (winner === BLACK) return 1;
  if (winner === WHITE) return -1;
  return 0;
}

function pickRandomMove(rng: XorShift32, moves: ScoredMove[], topK: number): Move {
  const k = Math.min(Math.max(1, topK), moves.length);
  const idx = rng.int(0, k);
  return moves[idx].move;
}

function pickSoftmaxMove(rng: XorShift32, moves: ScoredMove[], topK: number, temperature: number): Move {
  const k = Math.min(Math.max(1, topK), moves.length);
  if (k === 1) return moves[0].move;

  // Use a stable softmax over the top-K move scores.
  let maxScore = -Infinity;
  for (let i = 0; i < k; i++) {
    const s = moves[i].score;
    if (s > maxScore) maxScore = s;
  }

  const weights = new Array<number>(k);
  let sum = 0;
  for (let i = 0; i < k; i++) {
    const x = (moves[i].score - maxScore) / temperature;
    const w = Math.exp(Math.max(-50, Math.min(50, x)));
    weights[i] = w;
    sum += w;
  }

  if (!(sum > 0)) {
    // Fallback: uniform.
    return moves[rng.int(0, k)].move;
  }

  let r = rng.nextFloat01() * sum;
  for (let i = 0; i < k; i++) {
    r -= weights[i];
    if (r <= 0) return moves[i].move;
  }
  return moves[k - 1].move;
}

function chooseMove(
  opts: SelfPlayOptions,
  rng: XorShift32,
  board: Board,
  player: Color,
  nnueWeights: NnueWeights | null
): Move {
  const moves = generateAllMoves(board, player);
  if (moves.length === 0) {
    throw new Error('No legal moves (unexpected)');
  }

  if (opts.policy === 'random') {
    return pickRandomMove(rng, moves, opts.topK);
  }

  if (opts.policy === 'softmax') {
    return pickSoftmaxMove(rng, moves, opts.topK, opts.temperature);
  }

  if (opts.policy === 'search') {
    const r = findBestMove(board, player, opts.timeMs, opts.maxDepth, nnueWeights);
    if (!r.move) throw new Error('Search returned null move');
    return r.move;
  }

  // epsilon-greedy: with prob epsilon choose random, otherwise choose search if available,
  // else fall back to softmax.
  if (rng.nextFloat01() < opts.epsilon) {
    return pickRandomMove(rng, moves, opts.topK);
  }

  // If weights exist (or even if not), search is still stronger than pure heuristics.
  const r = findBestMove(board, player, opts.timeMs, opts.maxDepth, nnueWeights);
  if (r.move) return r.move;
  return pickSoftmaxMove(rng, moves, opts.topK, opts.temperature);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.shards > 1 && opts.shardIndex === null) {
    // Orchestrator mode: run shards in parallel then merge into the requested outPath.
    // eslint-disable-next-line no-console
    console.log('[selfplay] orchestrator', { shards: opts.shards, games: opts.games, out: opts.outPath });
    const partPaths: string[] = [];
    const shardPromises: Promise<void>[] = [];
    for (let s = 0; s < opts.shards; s++) {
      const out = `${opts.outPath}.part${s}`;
      partPaths.push(out);
      shardPromises.push(runShard(opts, out, s));
    }
    await Promise.all(shardPromises);
    await mergeDatasets(partPaths, opts.outPath);
    // eslint-disable-next-line no-console
    console.log('[selfplay] done', { out: opts.outPath });
    return;
  }
  const shardIndex = opts.shardIndex ?? 0;
  const localTotal = Math.ceil((opts.games - shardIndex) / opts.shards);

  const nnueWeights = opts.weightsPath ? await loadWeightsFromPath(opts.weightsPath) : null;
  // eslint-disable-next-line no-console
  console.log('[selfplay] start', {
    games: opts.games,
    maxPlies: opts.maxPlies,
    policy: opts.policy,
    weights: nnueWeights ? 'loaded' : 'none',
    out: opts.outPath,
    shardIndex: opts.shardIndex,
    shards: opts.shards,
  });

  await mkdir(dirname(opts.outPath), { recursive: true });
  const fh = await open(opts.outPath, 'w');

  // Header placeholder.
  const header = new Uint8Array(HEADER_BYTES);
  for (let i = 0; i < 8; i++) header[i] = DATASET_MAGIC.charCodeAt(i) & 0xff;
  new DataView(header.buffer).setUint32(8, DATASET_VERSION, true);
  new DataView(header.buffer).setUint32(12, 0, true); // recordCount placeholder
  await fh.write(header, 0, header.length, 0);

  let recordCount = 0;
  let fileOffset = HEADER_BYTES;

  let localDone = 0;
  for (let g = shardIndex; g < opts.games; g += opts.shards) {
    const board = createBoard();
    let player: Color = BLACK;
    const positions: Snapshot[] = [];

    let resultFromBlack: ResultFromBlack = 0;

    const gameSeed = (opts.seed * 0x9e3779b9 + g) >>> 0;
    const rng = new XorShift32(gameSeed);

    for (let ply = 0; ply < opts.maxPlies; ply++) {
      positions.push(snapshot(board, player));

      const move = chooseMove(opts, rng, board, player, nnueWeights);
      const undo = makeMove(board, move, player);
      const winner = getWinnerAfterMove(board, move, player);
      void undo; // (kept for possible future debugging)

      if (winner) {
        resultFromBlack = winnerToResultFromBlack(winner);
        break;
      }

      player = getOpponent(player);
    }

    // Write all recorded positions with the final outcome.
    for (const p of positions) {
      const rec = new Uint8Array(RECORD_BYTES);
      rec.set(p.cells, 0);
      rec[CELLS] = p.toMove;
      // store as signed byte (-1,0,1) in int8 range
      rec[CELLS + 1] = (resultFromBlack & 0xff) as unknown as number;

      await fh.write(rec, 0, rec.length, fileOffset);
      fileOffset += rec.length;
      recordCount++;
    }

    localDone++;
    if (localDone % 10 === 0 || localDone === localTotal) {
      // eslint-disable-next-line no-console
      console.log('[selfplay] games', localDone, '/', localTotal, 'records', recordCount, 'shard', opts.shardIndex);
    }
  }

  // Patch recordCount.
  const patch = new Uint8Array(4);
  new DataView(patch.buffer).setUint32(0, recordCount, true);
  await fh.write(patch, 0, patch.length, 12);

  await fh.close();
  // eslint-disable-next-line no-console
  console.log('[selfplay] done', { recordCount, out: opts.outPath });
}

void main();

