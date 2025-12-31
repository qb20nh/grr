/**
 * AI Web Worker for Gomoku Rift
 * Uses the new optimized AI engine with alpha-beta search
 */

import {
  boardFrom2D,
  findBestMove,
  createSearchSession,
  moveToLegacy,
  moveToKey,
  makeMove,
  unmakeMove,
  cloneBoard,
  getOpponent,
  getTranspositionTable,
  calculateTimeForMove,
  BLACK,
  WHITE,
  CONFIG,
} from './ai/index';
import type { Board, Color, Move, Position, UndoInfo } from './ai/types';
import type { SearchSession } from './ai/search';
import { runTacticalPuzzles } from './ai/puzzles';
import { runNpsBenchmark } from './ai/benchmark';
import type { NnueWeights } from './ai/nnue/weights';
import { getBundledWeightsUrl, loadNnueWeightsOptional } from './ai/nnue/weights';

interface WorkerState {
  board: (string | null)[][];
  aiColor: string | null;
  playerToMove?: 'black' | 'white';
  lastRiftedPosition: { row: number; col: number } | null;
}

interface FindMoveRequest {
  type: 'findBestMove';
  state: WorkerState;
  config?: {
    maxTime?: number;
    maxDepth?: number;
    debug?: boolean;
  };
}

interface RunPuzzlesRequest {
  type: 'runTacticalPuzzles';
  config?: {
    timeLimitMs?: number;
  };
}

interface BenchmarkNpsRequest {
  type: 'benchmarkNps';
  config?: {
    timeLimitMs?: number;
    maxDepth?: number;
    iterations?: number;
  };
}

interface PonderStartRequest {
  type: 'ponderStart';
  state: WorkerState;
  config?: {
    sliceMs?: number;
    maxDepth?: number;
    debug?: boolean;
  };
}

interface PonderStopRequest {
  type: 'ponderStop';
}

interface PositionUpdateRequest {
  type: 'positionUpdate';
  state: WorkerState;
  config?: {
    maxDepth?: number;
  };
}

interface MoveResult {
  type: 'result';
  move: {
    action: 'reinforce' | 'rift';
    positions: { row: number; col: number }[];
    score: number;
    depth: number;
    nodes: number;
    time: number;
    ponder?: {
      nodes: number;
      timeMs: number;
      bestDepth: number;
      bestScore: number;
      bestMove: { action: 'reinforce' | 'rift'; positions: { row: number; col: number }[] } | null;
      replyNodes: number;
      replyTimeMs: number;
      replyBestDepth: number;
      replyBestScore: number;
      replyBestMove: { action: 'reinforce' | 'rift'; positions: { row: number; col: number }[] } | null;
      predictedMoveKey: string | null;
      predictedHit: boolean | null;
      usedReplySession: boolean;
      tt: {
        hits: number;
        misses: number;
        collisions: number;
        hitsCurrentAge: number;
        hitsPrevAge: number;
        hitsOtherAge: number;
        reuseFromPrevPct: number; // [0,1]
      };
    };
  } | null;
}

interface PuzzlesResult {
  type: 'puzzlesResult';
  summary: ReturnType<typeof runTacticalPuzzles>;
}

interface BenchmarkNpsResult {
  type: 'benchmarkNpsResult';
  summary: ReturnType<typeof runNpsBenchmark>;
}

/**
 * Convert worker state to internal Board representation
 */
function convertState(state: WorkerState): { board: Board; player: Color } {
  // Convert lastRiftedPosition to index
  let koPosition: number | null = null;
  if (state.lastRiftedPosition) {
    koPosition = state.lastRiftedPosition.row * 15 + state.lastRiftedPosition.col;
  }
  
  // Convert 2D board to internal format
  const board = boardFrom2D(state.board, koPosition);
  
  // Determine player color
  const toMove = state.playerToMove ?? state.aiColor;
  const player: Color = toMove === 'black' ? BLACK : WHITE;
  
  return { board, player };
}

// ---- NNUE weights (optional) ----
let nnueWeightsPromise: Promise<NnueWeights | null> | null = null;

function getNnueWeights(): Promise<NnueWeights | null> {
  if (!nnueWeightsPromise) {
    nnueWeightsPromise = loadNnueWeightsOptional(getBundledWeightsUrl());
  }
  return nnueWeightsPromise;
}

// ---- Pondering (background search during human turn) ----
let ponderActive = false;
let ponderGeneration = 0;
let ponderRootSession: SearchSession | null = null;
let ponderReplySession: SearchSession | null = null;
let ponderSliceMs: number = 60;
let ponderMaxDepth: number = CONFIG.MAX_DEPTH;
let ponderDebug = false;
let ponderLatestPosition: { board: Board; player: Color } | null = null;

let ponderDeadlineMs = 0;

const PONDER_MAX_TIME_MS = 5000;

interface PonderSummary {
  nodes: number; // root+reply totals
  timeMs: number; // root+reply totals
  bestDepth: number; // root best depth (predicted human move search)
  bestScore: number; // root best score
  bestMove: { action: 'reinforce' | 'rift'; positions: { row: number; col: number }[] } | null; // predicted human move
  predictedMoveKey: string | null;
  predictedChildHash: string | null; // hash of position after predicted human move
  replyNodes: number;
  replyTimeMs: number;
  replyBestDepth: number;
  replyBestScore: number;
  replyBestMove: { action: 'reinforce' | 'rift'; positions: { row: number; col: number }[] } | null; // best AI reply in predicted position
}

let ponderRootTotalsNodes = 0;
let ponderRootTotalsMs = 0;
let ponderReplyTotalsNodes = 0;
let ponderReplyTotalsMs = 0;
let ponderPredictedMoveKey: string | null = null;
let ponderPredictedChildHash: string | null = null;
let ponderNnueWeights: NnueWeights | null = null;
let lastPonderSummary: PonderSummary | null = null;

function moveToLogObject(move: Move | null): { action: 'reinforce' | 'rift'; positions: { row: number; col: number }[] } | null {
  if (!move) return null;
  return { action: move.action, positions: moveToLegacy(move) };
}

function resetPonderingState(): void {
  ponderActive = false;
  ponderRootSession = null;
  ponderReplySession = null;
  ponderLatestPosition = null;
  ponderDeadlineMs = 0;
  ponderGeneration++;

  ponderRootTotalsNodes = 0;
  ponderRootTotalsMs = 0;
  ponderReplyTotalsNodes = 0;
  ponderReplyTotalsMs = 0;
  ponderPredictedMoveKey = null;
  ponderPredictedChildHash = null;
  ponderNnueWeights = null;
}

function refreshPredictedLine(): void {
  if (!ponderLatestPosition || !ponderRootSession) return;

  const best = ponderRootSession.getBest();
  const bestMove = best.move;
  if (!bestMove) return;

  const nextKey = moveToKey(bestMove);
  if (nextKey === ponderPredictedMoveKey && ponderReplySession) return;

  ponderPredictedMoveKey = nextKey;

  // Build predicted child position (after predicted human move).
  const child = cloneBoard(ponderLatestPosition.board);
  makeMove(child, bestMove, ponderLatestPosition.player);
  const replyPlayer = getOpponent(ponderLatestPosition.player);
  ponderPredictedChildHash = child.hash.toString();

  // Reset reply totals when the predicted line changes.
  ponderReplyTotalsNodes = 0;
  ponderReplyTotalsMs = 0;

  const tt = getTranspositionTable();
  if (!ponderReplySession) {
    ponderReplySession = createSearchSession(child, replyPlayer, ponderMaxDepth, tt, ponderNnueWeights);
  } else {
    ponderReplySession.setPosition(child, replyPlayer);
  }

  if (ponderDebug) {
    console.log('[AI Worker] Ponder predicted line updated', {
      predictedMove: moveToLogObject(bestMove),
      predictedChildHash: ponderPredictedChildHash,
    });
  }
}

function finalizePonderSummary(): void {
  if (!ponderLatestPosition || !ponderRootSession) {
    lastPonderSummary = null;
    return;
  }

  // Ensure we have the latest predicted line + child hash.
  refreshPredictedLine();

  const rootBest = ponderRootSession.getBest();
  const replyBest = ponderReplySession?.getBest() ?? null;

  lastPonderSummary = {
    nodes: ponderRootTotalsNodes + ponderReplyTotalsNodes,
    timeMs: ponderRootTotalsMs + ponderReplyTotalsMs,
    bestDepth: rootBest.depth ?? 0,
    bestScore: rootBest.score,
    bestMove: moveToLogObject(rootBest.move),
    predictedMoveKey: ponderPredictedMoveKey,
    predictedChildHash: ponderPredictedChildHash,
    replyNodes: ponderReplyTotalsNodes,
    replyTimeMs: ponderReplyTotalsMs,
    replyBestDepth: replyBest?.depth ?? 0,
    replyBestScore: replyBest?.score ?? 0,
    replyBestMove: moveToLogObject(replyBest?.move ?? null),
  };
}

function pausePonderingLoop(): void {
  finalizePonderSummary();

  if (ponderDebug && lastPonderSummary) {
    console.log('[AI Worker] Ponder paused', lastPonderSummary);
  }

  ponderActive = false;
  ponderDeadlineMs = 0;
  ponderGeneration++;
}

async function runPonderLoop(generation: number): Promise<void> {
  while (ponderActive && generation === ponderGeneration && ponderRootSession) {
    if (ponderDeadlineMs > 0 && Date.now() >= ponderDeadlineMs) {
      pausePonderingLoop();
      break;
    }

    // Allocate most ponder time to the predicted reply line.
    const rootSliceMs = Math.max(10, Math.floor(ponderSliceMs * 0.25));
    const replySliceMs = Math.max(10, ponderSliceMs - rootSliceMs);

    // 1) Search the human-to-move root to keep prediction fresh.
    {
      const t0 = Date.now();
      const slice = ponderRootSession.searchSlice(rootSliceMs);
      const dt = Date.now() - t0;
      ponderRootTotalsMs += dt;
      ponderRootTotalsNodes += slice.nodes ?? 0;
    }

    // 2) Ensure reply session exists for the current best predicted move.
    refreshPredictedLine();

    // 3) Search the AI reply line (the valuable part we may reuse on ponder hit).
    if (ponderReplySession) {
      const t0 = Date.now();
      const slice = ponderReplySession.searchSlice(replySliceMs);
      const dt = Date.now() - t0;
      ponderReplyTotalsMs += dt;
      ponderReplyTotalsNodes += slice.nodes ?? 0;

      if (ponderDebug && (slice.depth ?? 0) > 0 && (slice.depth ?? 0) % 2 === 0) {
        console.log('[AI Worker] Ponder reply progress', {
          replyNodes: ponderReplyTotalsNodes,
          replyTimeMs: ponderReplyTotalsMs,
          bestDepth: slice.depth ?? 0,
          bestScore: slice.score,
        });
      }
    }

    // Yield to the worker event loop.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
}

async function startPondering(request: PonderStartRequest): Promise<void> {
  const { board, player } = convertState(request.state);
  ponderSliceMs = Math.max(10, Math.min(200, Math.floor(request.config?.sliceMs ?? 60)));
  ponderMaxDepth = request.config?.maxDepth ?? CONFIG.MAX_DEPTH;
  ponderDebug = Boolean(request.config?.debug);

  resetPonderingState();
  ponderActive = true;
  ponderLatestPosition = { board, player };
  ponderDeadlineMs = Date.now() + PONDER_MAX_TIME_MS;
  const myGen = ponderGeneration;
  lastPonderSummary = null;

  const nnueWeights = await getNnueWeights();
  // If pondering was cancelled/restarted while awaiting weights, bail.
  if (!ponderActive || myGen !== ponderGeneration) return;

  ponderNnueWeights = nnueWeights;

  const tt = getTranspositionTable();
  ponderRootSession = createSearchSession(board, player, ponderMaxDepth, tt, nnueWeights);
  refreshPredictedLine();

  if (ponderDebug) {
    console.log('[AI Worker] Ponder start', {
      sliceMs: ponderSliceMs,
      maxDepth: ponderMaxDepth,
      toMove: request.state.playerToMove ?? request.state.aiColor,
      stoneCount: board.blackCount + board.whiteCount,
      predictedMove: moveToLogObject(ponderRootSession.getBest().move),
      predictedChildHash: ponderPredictedChildHash,
    });
  }

  void runPonderLoop(myGen);
}

function updatePonderPosition(request: PositionUpdateRequest): void {
  const { board, player } = convertState(request.state);
  ponderMaxDepth = request.config?.maxDepth ?? ponderMaxDepth;
  ponderLatestPosition = { board, player };

  ponderRootTotalsNodes = 0;
  ponderRootTotalsMs = 0;
  ponderReplyTotalsNodes = 0;
  ponderReplyTotalsMs = 0;
  ponderPredictedMoveKey = null;
  ponderPredictedChildHash = null;
  lastPonderSummary = null;

  if (ponderRootSession) {
    ponderRootSession.setPosition(board, player);
  }
  ponderReplySession = null;
  refreshPredictedLine();

  if (ponderDebug) {
    console.log('[AI Worker] Ponder position updated', {
      toMove: request.state.playerToMove ?? request.state.aiColor,
      stoneCount: board.blackCount + board.whiteCount,
    });
  }
}

/**
 * Handle find best move request
 */
async function handleFindBestMove(request: FindMoveRequest): Promise<MoveResult> {
  const startTime = Date.now();
  
  try {
    // Stop background pondering loop, but KEEP ponder sessions for possible reuse on a ponder hit.
    pausePonderingLoop();

    const { board, player } = convertState(request.state);
    
    // ---- Time allocation (adaptive, hard-capped) ----
    // Never exceed 5000ms (user constraint). Still allow returning faster in obvious positions.
    const requestedTime = request.config?.maxTime && request.config.maxTime > 0
      ? request.config.maxTime
      : CONFIG.DEFAULT_TIME;
    const hardCapMs = 5000;
    const baseTime = Math.max(CONFIG.MIN_TIME, Math.min(hardCapMs, Math.round(requestedTime)));
    const adaptiveTime = calculateTimeForMove(board, player, baseTime);
    // Treat `baseTime` as a hard ceiling for this move (caller intent), and also cap at 5s.
    const timeLimit = Math.max(CONFIG.MIN_TIME, Math.min(baseTime, hardCapMs, Math.round(adaptiveTime)));
    
    const maxDepth = request.config?.maxDepth ?? CONFIG.MAX_DEPTH;
    
    if (request.config?.debug) {
      console.log('[AI Worker] Starting search', {
        timeLimit,
        maxDepth,
        stoneCount: board.blackCount + board.whiteCount,
      });
    }

    const nnueWeights = await getNnueWeights();

    // ---- Ponder impact snapshot (was computed while opponent was thinking) ----
    const ponder = lastPonderSummary;
    lastPonderSummary = null;
    const predictedHit = ponder?.predictedChildHash ? ponder.predictedChildHash === board.hash.toString() : null;

    const tt = getTranspositionTable();
    tt.resetStats();
    
    // Find best move (prefer continuing the predicted-line reply session on ponder hit).
    let usedReplySession = false;
    let result: ReturnType<typeof findBestMove>;
    if (predictedHit === true && ponderReplySession && ponderPredictedChildHash === board.hash.toString()) {
      usedReplySession = true;
      result = ponderReplySession.searchSlice(timeLimit);
    } else {
      result = findBestMove(board, player, timeLimit, maxDepth, nnueWeights);
    }
    const nodes = result.nodes ?? 0;
    const ttStats = tt.getProbeStats();
    const reuseFromPrevPct = ttStats.hits > 0 ? ttStats.hitsPrevAge / ttStats.hits : 0;
    
    if (!result.move) {
      console.warn('[AI Worker] No move found');
      return { type: 'result', move: null };
    }
    
    // Convert move to legacy format
    const positions = moveToLegacy(result.move);
    
    const moveResult: MoveResult = {
      type: 'result',
      move: {
        action: result.move.action,
        positions,
        score: result.score,
        depth: result.depth ?? 1,
        nodes,
        time: Date.now() - startTime,
        ponder: ponder
          ? {
              nodes: ponder.nodes,
              timeMs: ponder.timeMs,
              bestDepth: ponder.bestDepth,
              bestScore: ponder.bestScore,
              bestMove: ponder.bestMove,
              replyNodes: ponder.replyNodes,
              replyTimeMs: ponder.replyTimeMs,
              replyBestDepth: ponder.replyBestDepth,
              replyBestScore: ponder.replyBestScore,
              replyBestMove: ponder.replyBestMove,
              predictedMoveKey: ponder.predictedMoveKey,
              predictedHit,
              usedReplySession,
              tt: {
                hits: ttStats.hits,
                misses: ttStats.misses,
                collisions: ttStats.collisions,
                hitsCurrentAge: ttStats.hitsCurrentAge,
                hitsPrevAge: ttStats.hitsPrevAge,
                hitsOtherAge: ttStats.hitsOtherAge,
                reuseFromPrevPct,
              },
            }
          : undefined,
      },
    };
    
    if (request.config?.debug) {
      console.log('[AI Worker] Move found', moveResult.move);
    }
    
    // Clear ponder sessions after using them (next turn will start new pondering).
    resetPonderingState();
    return moveResult;
    
  } catch (error) {
    console.error('[AI Worker] Error finding move:', error);
    return { type: 'result', move: null };
  }
}

// Web Worker message handler
self.onmessage = (e: MessageEvent) => {
  const request = e.data;

  if (request.type === 'benchmarkNps') {
    const cfg = (request as BenchmarkNpsRequest).config;
    const summary = runNpsBenchmark({
      timeLimitMs: cfg?.timeLimitMs,
      maxDepth: cfg?.maxDepth,
      iterations: cfg?.iterations,
    });
    const result: BenchmarkNpsResult = { type: 'benchmarkNpsResult', summary };
    self.postMessage(result);
    return;
  }

  if (request.type === 'ponderStart') {
    void startPondering(request as PonderStartRequest);
    return;
  }

  if (request.type === 'ponderStop') {
    pausePonderingLoop();
    return;
  }

  if (request.type === 'positionUpdate') {
    updatePonderPosition(request as PositionUpdateRequest);
    return;
  }
  
  if (request.type === 'findBestMove') {
    void (async () => {
      const result = await handleFindBestMove(request as FindMoveRequest);
      self.postMessage(result);
    })();
    return;
  }

  if (request.type === 'runTacticalPuzzles') {
    const cfg = (request as RunPuzzlesRequest).config;
    const summary = runTacticalPuzzles(cfg?.timeLimitMs ?? 250);
    const result: PuzzlesResult = { type: 'puzzlesResult', summary };
    self.postMessage(result);
  }
};

export {};
