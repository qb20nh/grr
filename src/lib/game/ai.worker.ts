/**
 * AI Web Worker for Gomoku Rift
 * Uses the new optimized AI engine with alpha-beta search
 */

import {
  boardFrom2D,
  boardTo2D,
  createReinforceMove,
  createRiftMove,
  createSingleWinMove,
  findBestMove,
  createSearchSession,
  moveToLegacy,
  toIndex,
  moveToKey,
  makeMove,
  unmakeMove,
  cloneBoard,
  getOpponent,
  validateReinforce,
  validateRift,
  isValidPlacement,
  isSingleWinMove,
  checkWinAt,
  generateAllMoves,
  createSharedTranspositionTableBacking,
  getTranspositionTable,
  BLACK,
  EMPTY,
  WHITE,
  CONFIG,
  BOARD_SIZE,
} from './ai/index';
import { applyScoringAndClear } from './ai/board';
import type { Board, Color, Move, Position, UndoInfo } from './ai/types';
import type { SearchSession } from './ai/search';
import { runTacticalPuzzles } from './ai/puzzles';
import { runNpsBenchmark } from './ai/benchmark';
import type { Dihedral } from './ai/dihedral';
import { randomDihedral, applyInverseDihedralPos, transformLegacyBoard, transformLegacyKo } from './ai/dihedral';
import type { OpeningPreset } from './types';
import type { SharedTranspositionTableBacking } from './ai/index';
import { getOpeningPly1ReplyMoveFilter, getOpeningRootMoveFilter } from './ai/openingFilters';
import { LONG_PRO_RIFT_FORBIDDEN_FIRST_TURNS } from './riftRules';

const NO_RIFT_FILTER = (m: Move): boolean => m.action !== 'rift';

function combineMoveFilters(
  a: ((m: Move) => boolean) | null,
  b: ((m: Move) => boolean) | null
): ((m: Move) => boolean) | null {
  if (a && b) return (m: Move) => a(m) && b(m);
  return a ?? b;
}

function noRiftFilterForOpening(openingPreset: OpeningPreset, moveIndex: number): ((m: Move) => boolean) | null {
  if (openingPreset !== 'long-pro') return null;
  return moveIndex < LONG_PRO_RIFT_FORBIDDEN_FIRST_TURNS ? NO_RIFT_FILTER : null;
}

interface WorkerState {
  board: (string | null)[][];
  aiColor: string | null;
  playerToMove?: 'black' | 'white';
  lastRiftedPosition: { row: number; col: number } | null;
  scores?: { black: number; white: number };
  scoreToWin?: number;
  openingPreset?: OpeningPreset;
  moveIndex?: number;
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
  resign?: {
    winner: 'black' | 'white';
    score: number;
    depth: number;
  };
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
  error?: {
    message: string;
    stack?: string;
    context?: Record<string, unknown>;
  };
}

interface UltraAnalyzeRootMovesResult {
  type: 'analyzeRootMovesResult';
  best: {
    move: Move;
    score: number;
    depth: number;
    nodes: number;
  } | null;
  totalNodes: number;
}

interface PuzzlesResult {
  type: 'puzzlesResult';
  summary: ReturnType<typeof runTacticalPuzzles>;
}

interface BenchmarkNpsResult {
  type: 'benchmarkNpsResult';
  summary: ReturnType<typeof runNpsBenchmark>;
}

const CENTER_RC = Math.floor(BOARD_SIZE / 2);
const CENTER_INDEX = toIndex(CENTER_RC, CENTER_RC);

function isMateCodedLossScore(score: number, depth: number, maxDepth: number): boolean {
  if (!Number.isFinite(score)) return false;
  if (score < CONFIG.LOSS_SCORE) return false;

  const d = Number.isFinite(depth) && depth > 0 ? Math.floor(depth) : Math.max(1, Math.floor(maxDepth));
  // Upper bound for the ply-offset used in mate-coded terminal scores:
  // depth (main search) + quiescence + small margin for extensions / off-by-one.
  const maxMatePlies = d + CONFIG.QUIESCENCE_DEPTH + 4;

  return score <= CONFIG.LOSS_SCORE + maxMatePlies;
}

// ---- Ultra shared-TT backing (reuse to avoid repeated large SAB allocations) ----
let ultraSharedTTBacking: SharedTranspositionTableBacking | null = null;

function getUltraSharedTTBackingBestEffort(): SharedTranspositionTableBacking | null {
  if (ultraSharedTTBacking) return ultraSharedTTBacking;

  // Best effort: try full TT size first, then shrink until it fits.
  // This prevents Ultra from degrading into "instamove" due to allocation failure.
  const maxPow = Math.floor(Math.log2(CONFIG.TT_SIZE));
  const minPow = 18; // 262k entries (~small but safe)
  for (let pow = maxPow; pow >= minPow; pow--) {
    const size = 1 << pow;
    try {
      ultraSharedTTBacking = createSharedTranspositionTableBacking(size);
      return ultraSharedTTBacking;
    } catch {
      // try smaller
    }
  }

  return null;
}

function normalizeMoveIndex(value: unknown): number {
  if (typeof value !== 'number') return 0;
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

function normalizeOpeningPreset(value: unknown): OpeningPreset {
  if (value === 'long-pro' || value === 'standard-empty' || value === 'legacy-black-center-white-first') {
    return value;
  }
  return 'long-pro';
}

function normalizeNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number') return fallback;
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function normalizeScoreToWin(value: unknown): number {
  // 0 means “unlimited” (play until exhaustion).
  return normalizeNonNegativeInt(value, 1);
}

function normalizeScores(value: unknown): { black: number; white: number } {
  const v = value as any;
  return {
    black: normalizeNonNegativeInt(v?.black, 0),
    white: normalizeNonNegativeInt(v?.white, 0),
  };
}

/**
 * Convert worker state to internal Board representation
 */
function convertState(state: WorkerState): {
  board: Board;
  player: Color;
  openingPreset: OpeningPreset;
  moveIndex: number;
  scores: { black: number; white: number };
  scoreToWin: number;
} {
  const d = activeDihedral ?? { rot: 0, reflect: false };
  const board2d = activeDihedral ? transformLegacyBoard(state.board, d) : state.board;
  const koPos = activeDihedral ? transformLegacyKo(state.lastRiftedPosition, d) : state.lastRiftedPosition;

  // Convert lastRiftedPosition to index
  let koPosition: number | null = null;
  if (koPos) {
    koPosition = koPos.row * 15 + koPos.col;
  }
  
  // Convert 2D board to internal format
  const board = boardFrom2D(board2d, koPosition);
  
  // Determine player color
  const toMove = state.playerToMove ?? state.aiColor;
  const player: Color = toMove === 'black' ? BLACK : WHITE;
  
  const openingPreset = normalizeOpeningPreset(state.openingPreset);
  const moveIndex = normalizeMoveIndex(state.moveIndex);
  const scores = normalizeScores(state.scores);
  const scoreToWin = normalizeScoreToWin(state.scoreToWin);

  return { board, player, openingPreset, moveIndex, scores, scoreToWin };
}

// ---- Dihedral randomization (per move) ----
let activeDihedral: Dihedral | null = null;

function ensureActiveDihedral(): Dihedral {
  if (!activeDihedral) {
    activeDihedral = randomDihedral();
  }
  return activeDihedral;
}

function clearActiveDihedral(): void {
  activeDihedral = null;
}

function untransformPositions(positions: { row: number; col: number }[]): { row: number; col: number }[] {
  if (!activeDihedral) return positions;
  const d = activeDihedral;
  return positions.map(p => applyInverseDihedralPos(p, d));
}

function untransformLogMove(
  m: { action: 'reinforce' | 'rift'; positions: { row: number; col: number }[] } | null
): { action: 'reinforce' | 'rift'; positions: { row: number; col: number }[] } | null {
  if (!m) return null;
  return { action: m.action, positions: untransformPositions(m.positions) };
}

// ---- Pondering (background search during human turn) ----
let ponderActive = false;
let ponderGeneration = 0;
let ponderRootSession: SearchSession | null = null;
let ponderReplySession: SearchSession | null = null;
let ponderSliceMs: number = 60;
let ponderMaxDepth: number = CONFIG.MAX_DEPTH;
let ponderDebug = false;
let ponderLatestPosition: {
  board: Board;
  player: Color;
  openingPreset: OpeningPreset;
  moveIndex: number;
  scores: { black: number; white: number };
  scoreToWin: number;
} | null = null;

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
let lastPonderSummary: PonderSummary | null = null;

function moveToLogObject(move: Move | null): { action: 'reinforce' | 'rift'; positions: { row: number; col: number }[] } | null {
  if (!move) return null;
  return { action: move.action, positions: moveToLegacy(move) };
}

function isMoveLegal(board: Board, move: Move, player: Color): boolean {
  if (move.action === 'rift') {
    return validateRift(board, move.pos, player);
  }

  if (isSingleWinMove(move)) {
    if (!isValidPlacement(board, move.pos1)) return false;
    // Temporarily place the stone (without touching hash / counts) and test exact-5.
    const prev = board.cells[move.pos1];
    board.cells[move.pos1] = player;
    const wins = checkWinAt(board, move.pos1, player);
    board.cells[move.pos1] = prev;
    return wins;
  }

  return validateReinforce(board, move.pos1, move.pos2, player);
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
}

function refreshPredictedLine(): void {
  if (!ponderLatestPosition || !ponderRootSession) return;

  // Special-case: Long Pro forced opening (Black must play center single stone on move 0).
  const best = ponderRootSession.getBest();
  const bestMove = best.move;
  const forcedLongProCenter =
    ponderLatestPosition.openingPreset === 'long-pro' &&
    ponderLatestPosition.moveIndex === 0 &&
    ponderLatestPosition.player === BLACK;
  const predictedMove = forcedLongProCenter ? createSingleWinMove(CENTER_INDEX) : bestMove;
  if (!predictedMove) return;

  const nextKey = moveToKey(predictedMove);
  if (nextKey === ponderPredictedMoveKey && ponderReplySession) return;

  ponderPredictedMoveKey = nextKey;

  // Build predicted child position (after predicted human move).
  const child = cloneBoard(ponderLatestPosition.board);
  makeMove(child, predictedMove, ponderLatestPosition.player);
  const replyPlayer = getOpponent(ponderLatestPosition.player);
  const childScores = { ...ponderLatestPosition.scores };
  const scoring = applyScoringAndClear(child, predictedMove, ponderLatestPosition.player);
  if (scoring.scoredBy === BLACK) childScores.black += scoring.points;
  else if (scoring.scoredBy === WHITE) childScores.white += scoring.points;
  ponderPredictedChildHash = child.hash.toString();
  const replyMoveIndex = ponderLatestPosition.moveIndex + 1;
  const replyRootFilter = combineMoveFilters(
    getOpeningRootMoveFilter(ponderLatestPosition.openingPreset, replyMoveIndex, replyPlayer),
    noRiftFilterForOpening(ponderLatestPosition.openingPreset, replyMoveIndex)
  );
  const replyPly1Filter = combineMoveFilters(
    getOpeningPly1ReplyMoveFilter(ponderLatestPosition.openingPreset, replyMoveIndex, replyPlayer),
    noRiftFilterForOpening(ponderLatestPosition.openingPreset, replyMoveIndex + 1)
  );
  const replyPly2Filter = noRiftFilterForOpening(ponderLatestPosition.openingPreset, replyMoveIndex + 2);

  // Reset reply totals when the predicted line changes.
  ponderReplyTotalsNodes = 0;
  ponderReplyTotalsMs = 0;

  const tt = getTranspositionTable();
  if (!ponderReplySession) {
    ponderReplySession = createSearchSession(
      child,
      replyPlayer,
      ponderMaxDepth,
      tt,
      null,
      replyRootFilter,
      replyPly1Filter,
      replyPly2Filter,
      childScores,
      ponderLatestPosition.scoreToWin
    );
  } else {
    ponderReplySession.setPosition(
      child,
      replyPlayer,
      replyRootFilter,
      replyPly1Filter,
      replyPly2Filter,
      childScores,
      ponderLatestPosition.scoreToWin
    );
  }

  if (ponderDebug) {
    console.log('[AI Worker] Ponder predicted line updated', {
      predictedMove: moveToLogObject(predictedMove),
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
  // Sample a new random dihedral for the upcoming AI move (and keep it stable across pondering).
  activeDihedral = randomDihedral();
  const { board, player, openingPreset, moveIndex, scores, scoreToWin } = convertState(request.state);
  ponderSliceMs = Math.max(10, Math.min(200, Math.floor(request.config?.sliceMs ?? 60)));
  ponderMaxDepth = request.config?.maxDepth ?? CONFIG.MAX_DEPTH;
  ponderDebug = Boolean(request.config?.debug);

  resetPonderingState();
  ponderActive = true;
  ponderLatestPosition = { board, player, openingPreset, moveIndex, scores, scoreToWin };
  ponderDeadlineMs = Date.now() + PONDER_MAX_TIME_MS;
  const myGen = ponderGeneration;
  lastPonderSummary = null;

  const tt = getTranspositionTable();
  const rootMoveFilter = combineMoveFilters(
    getOpeningRootMoveFilter(openingPreset, moveIndex, player),
    noRiftFilterForOpening(openingPreset, moveIndex)
  );
  const ply1MoveFilter = combineMoveFilters(
    getOpeningPly1ReplyMoveFilter(openingPreset, moveIndex, player),
    noRiftFilterForOpening(openingPreset, moveIndex + 1)
  );
  const ply2MoveFilter = noRiftFilterForOpening(openingPreset, moveIndex + 2);
  // NNUE disabled (handcrafted eval only): pass null weights.
  ponderRootSession = createSearchSession(
    board,
    player,
    ponderMaxDepth,
    tt,
    null,
    rootMoveFilter,
    ply1MoveFilter,
    ply2MoveFilter,
    scores,
    scoreToWin
  );
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
  // Keep the same dihedral for this upcoming move; if absent (shouldn't happen), create one.
  ensureActiveDihedral();
  const { board, player, openingPreset, moveIndex, scores, scoreToWin } = convertState(request.state);
  ponderMaxDepth = request.config?.maxDepth ?? ponderMaxDepth;
  ponderLatestPosition = { board, player, openingPreset, moveIndex, scores, scoreToWin };

  ponderRootTotalsNodes = 0;
  ponderRootTotalsMs = 0;
  ponderReplyTotalsNodes = 0;
  ponderReplyTotalsMs = 0;
  ponderPredictedMoveKey = null;
  ponderPredictedChildHash = null;
  lastPonderSummary = null;

  if (ponderRootSession) {
    const rootMoveFilter = combineMoveFilters(
      getOpeningRootMoveFilter(openingPreset, moveIndex, player),
      noRiftFilterForOpening(openingPreset, moveIndex)
    );
    const ply1MoveFilter = combineMoveFilters(
      getOpeningPly1ReplyMoveFilter(openingPreset, moveIndex, player),
      noRiftFilterForOpening(openingPreset, moveIndex + 1)
    );
    const ply2MoveFilter = noRiftFilterForOpening(openingPreset, moveIndex + 2);
    ponderRootSession.setPosition(board, player, rootMoveFilter, ply1MoveFilter, ply2MoveFilter, scores, scoreToWin);
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

    // Ensure a dihedral exists for this move (AI-vs-AI has no ponderStart).
    ensureActiveDihedral();
    const { board, player, openingPreset, moveIndex, scores, scoreToWin } = convertState(request.state);
    const rootMoveFilter = combineMoveFilters(
      getOpeningRootMoveFilter(openingPreset, moveIndex, player),
      noRiftFilterForOpening(openingPreset, moveIndex)
    );
    const ply1ReplyMoveFilter = combineMoveFilters(
      getOpeningPly1ReplyMoveFilter(openingPreset, moveIndex, player),
      noRiftFilterForOpening(openingPreset, moveIndex + 1)
    );
    const ply2MoveFilter = noRiftFilterForOpening(openingPreset, moveIndex + 2);
    
    // Special-case: Long Pro forced opening move (Black must play center single stone on move 0).
    if (openingPreset === 'long-pro' && moveIndex === 0 && player === BLACK) {
      // Clear ponder sessions after using them (next turn will start new pondering).
      resetPonderingState();
      clearActiveDihedral();
      return {
        type: 'result',
        move: {
          action: 'reinforce',
          positions: untransformPositions([{ row: CENTER_RC, col: CENTER_RC }]),
          score: 0,
          depth: 0,
          nodes: 0,
          time: Date.now() - startTime,
        },
      };
    }

    // ---- Time allocation (hard-capped) ----
    // Default behavior is to use the caller's full per-move budget (clamped),
    // and rely on the search to terminate early only for forced outcomes.
    // Spectate can request "Ultra" (maxTime=0) which triggers a parallel, 60s-capped root-split search.
    const requestedMaxTime = request.config?.maxTime;
    const ultraThink = requestedMaxTime === 0;
    const requestedTime =
      typeof requestedMaxTime === 'number' && requestedMaxTime > 0
        ? requestedMaxTime
        : CONFIG.DEFAULT_TIME;
    const hardCapMs = 5000;
    const baseTime = Math.max(CONFIG.MIN_TIME, Math.min(hardCapMs, Math.round(requestedTime)));
    const timeLimit = baseTime;
    
    const maxDepth = request.config?.maxDepth ?? CONFIG.MAX_DEPTH;
    
    if (request.config?.debug) {
      console.log('[AI Worker] Starting search', {
        timeLimit: ultraThink ? 'ultra(60s)' : timeLimit,
        maxDepth,
        stoneCount: board.blackCount + board.whiteCount,
      });
    }

    // NNUE disabled (handcrafted eval only): keep null weights.
    const nnueWeights = null;

    // ---- Ponder impact snapshot (was computed while opponent was thinking) ----
    const ponder = lastPonderSummary;
    lastPonderSummary = null;
    const predictedHit = ponder?.predictedChildHash ? ponder.predictedChildHash === board.hash.toString() : null;

    const tt = getTranspositionTable();
    tt.resetStats();
    
    // Find best move (prefer continuing the predicted-line reply session on ponder hit).
    let usedReplySession = false;
    // Initialize defensively so TypeScript can prove we never read before assignment.
    let result: ReturnType<typeof findBestMove> = {
      completed: true,
      score: 0,
      move: null,
      depth: 0,
      nodes: 0,
    };
    let nodes = 0;

    if (ultraThink) {
      // ---- UltraThink: 60s capped + all cores ----
      const ULTRA_MAX_TIME_MS = 60000;
      const deadlineMs = Date.now() + ULTRA_MAX_TIME_MS;

      const allRootMoves = generateAllMoves(board, player, { scores, scoreToWin });
      // Opening-aware root filtering (with safety fallback if it eliminates everything).
      const rootMoves = rootMoveFilter
        ? (() => {
            const filtered = allRootMoves.filter(m => rootMoveFilter(m.move));
            return filtered.length > 0 ? filtered : allRootMoves;
          })()
        : allRootMoves;

      // Fast-path: immediate winning root move (avoid spawning any pool).
      for (const { move } of rootMoves) {
        const undo = makeMove(board, move, player);
        const scoring = applyScoringAndClear(board, move, player);
        const b = scores.black + (scoring.scoredBy === BLACK ? scoring.points : 0);
        const w = scores.white + (scoring.scoredBy === WHITE ? scoring.points : 0);
        const matchWinner =
          scoreToWin !== 0 && (b >= scoreToWin || w >= scoreToWin)
            ? (b >= scoreToWin ? BLACK : WHITE)
            : null;

        if (scoring.cleared && scoring.scoredBy !== null) {
          for (const idx of scoring.cleared) {
            if (board.cells[idx] !== EMPTY) continue;
            board.cells[idx] = scoring.scoredBy;
            if (scoring.scoredBy === BLACK) board.blackCount++;
            else if (scoring.scoredBy === WHITE) board.whiteCount++;
          }
        }
        unmakeMove(board, undo, player);

        if (matchWinner === player) {
          result = {
            completed: true,
            score: CONFIG.WIN_SCORE,
            move,
            depth: 1,
            nodes: rootMoves.length,
          };
          nodes = rootMoves.length;
          // Clear ponder sessions after using them (next turn will start new pondering).
          resetPonderingState();
          return {
            type: 'result',
            move: {
              action: move.action,
              positions: moveToLegacy(move),
              score: CONFIG.WIN_SCORE,
              depth: 1,
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
                      hits: 0,
                      misses: 0,
                      collisions: 0,
                      hitsCurrentAge: 0,
                      hitsPrevAge: 0,
                      hitsOtherAge: 0,
                      reuseFromPrevPct: 0,
                    },
                  }
                : undefined,
            },
          };
        }
      }

      const movesOnly: Move[] = rootMoves.map(m => m.move);

      // Cross-origin isolation is required for SharedArrayBuffer (shared TT).
      const canUseSharedTT =
        typeof SharedArrayBuffer !== 'undefined' &&
        typeof Atomics !== 'undefined' &&
        (globalThis as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;

      // Worker pool sizing (use all available threads).
      const hc = (globalThis as unknown as { navigator?: { hardwareConcurrency?: number } }).navigator?.hardwareConcurrency;
      const workerCount = Math.max(1, Math.min(Math.floor(hc ?? 1), movesOnly.length));

      // The Ultra sub-workers must analyze the same dihedral-transformed position as the main worker.
      // We send a legacy 2D board reconstructed from the internal `Board`, which is already transformed.
      const koIndex = board.koPosition;
      const lastRiftedPosition =
        typeof koIndex === 'number'
          ? { row: Math.floor(koIndex / BOARD_SIZE), col: koIndex % BOARD_SIZE }
          : null;
      const ultraState = {
        board: boardTo2D(board),
        playerToMove: player === BLACK ? 'black' : 'white',
        lastRiftedPosition,
        scores,
        scoreToWin,
        openingPreset,
        moveIndex,
      } as const;

      const waitForType = (w: Worker, expectedType: string, timeoutMs: number): Promise<any | null> =>
        new Promise(resolve => {
          const onMsg = (ev: MessageEvent) => {
            const data = ev.data as any;
            if (!data || data.type !== expectedType) return;
            cleanup();
            resolve(data);
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

      const waitForRootMoveResult = (w: Worker, requestId: number, timeoutMs: number): Promise<any | null> =>
        new Promise(resolve => {
          const onMsg = (ev: MessageEvent) => {
            const data = ev.data as any;
            if (!data || data.type !== 'searchRootMoveResult') return;
            if (data.requestId !== requestId) return;
            cleanup();
            resolve(data);
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

      let ultraPvsRequestId = 1;
      const runRootMove = async (
        w: Worker,
        rootMove: Move,
        depth: number,
        alpha: number,
        beta: number,
        deadline: number
      ): Promise<{ completed: boolean; score: number; nodes: number } | null> => {
        const waitMs = Math.max(0, deadline - Date.now()) + 50;
        const requestId = ultraPvsRequestId++;
        const wait = waitForRootMoveResult(w, requestId, waitMs);
        w.postMessage({
          type: 'searchRootMove',
          requestId,
          rootMove,
          depth,
          alpha,
          beta,
          deadlineMs: deadline,
        });
        const data = await wait;
        if (!data || data.type !== 'searchRootMoveResult') return null;
        return {
          completed: Boolean(data.completed),
          score: Number(data.score ?? 0),
          nodes: Number(data.nodes ?? 0),
        };
      };

      const runUltraRootSplitFallback = async (): Promise<void> => {
        // ---- Fallback: existing parallel root-split (no shared SAB) ----
        // Keep total TT memory roughly bounded: divide TT size across the pool (power-of-two).
        const ttPow = Math.log2(CONFIG.TT_SIZE);
        const wcPow = Math.ceil(Math.log2(workerCount));
        const perWorkerPow = Math.max(16, Math.floor(ttPow) - wcPow);
        const ttSize = 1 << perWorkerPow;

        const buckets: Move[][] = Array.from({ length: workerCount }, () => []);
        for (let i = 0; i < movesOnly.length; i++) {
          buckets[i % workerCount]!.push(movesOnly[i]);
        }

        const workers: Worker[] = [];
        const results: Array<{ best: UltraAnalyzeRootMovesResult['best']; totalNodes: number } | null> = [];

        // Give workers a small grace window beyond the nominal deadline to post their final result.
        // (They search until `deadlineMs`, then post; terminating exactly at the deadline can drop the message.)
        const graceMs = 150;
        const waitUntilMs = deadlineMs + graceMs;

        const waitFor = (w: Worker, idx: number): Promise<void> =>
          new Promise(resolve => {
            const onMsg = (ev: MessageEvent) => {
              const data = ev.data as UltraAnalyzeRootMovesResult;
              if (!data || data.type !== 'analyzeRootMovesResult') return;
              cleanup();
              results[idx] = { best: data.best, totalNodes: Number(data.totalNodes ?? 0) };
              resolve();
            };
            const onErr = () => {
              cleanup();
              resolve();
            };
            const timer = setTimeout(() => {
              cleanup();
              resolve();
            }, Math.max(1, waitUntilMs - Date.now()));
            const cleanup = () => {
              clearTimeout(timer);
              w.removeEventListener('message', onMsg);
              w.removeEventListener('error', onErr);
            };
            w.addEventListener('message', onMsg);
            w.addEventListener('error', onErr, { once: true });
          });

        const promises: Promise<void>[] = [];
        for (let i = 0; i < workerCount; i++) {
          const subset = buckets[i]!;
          if (subset.length === 0) {
            results[i] = null;
            continue;
          }
          const w = new Worker(new URL('./ai/ultraSearch.worker.ts', import.meta.url), { type: 'module' });
          workers.push(w);
          promises.push(waitFor(w, i));
          w.postMessage({
            type: 'analyzeRootMoves',
            state: ultraState,
            rootMoves: subset,
            maxDepth,
            deadlineMs,
            ttSize,
          });
        }

        // Wait until all workers respond OR the post-deadline grace window expires.
        await Promise.allSettled(promises);

        for (const w of workers) w.terminate();

        // Reduce to a best move (prefer deeper, then score).
        let localNodes = 0;
        let best: { move: Move; score: number; depth: number; nodes: number } | null = null;
        for (const entry of results) {
          if (!entry) continue;
          localNodes += entry.totalNodes;
          const r = entry.best;
          if (!r) continue;
          if (!best) {
            best = r;
            continue;
          }
          if ((r.depth ?? 0) !== (best.depth ?? 0)) {
            if ((r.depth ?? 0) > (best.depth ?? 0)) best = r;
            continue;
          }
          if ((r.score ?? 0) > (best.score ?? 0)) {
            best = r;
          } else if (best && (r.score ?? 0) === (best.score ?? 0)) {
            if (Math.random() < 0.5) best = r;
          }
        }

        if (!best) {
          // Last-resort: run a local search for whatever time remains (at least a tiny slice),
          // so we don't return a misleading "all zeros" stat line.
          const remainingMs = Math.max(25, deadlineMs - Date.now());
        const local = findBestMove(
            board,
            player,
            remainingMs,
            maxDepth,
            nnueWeights,
            rootMoveFilter,
            ply1ReplyMoveFilter,
          ply2MoveFilter,
          scores,
          scoreToWin
          );
          result = local;
          nodes = local.nodes ?? 0;
        } else {
          nodes = localNodes;
          result = {
            completed: true,
            score: best.score,
            move: best.move,
            depth: best.depth,
            nodes,
          };
        }
      };

      let usedSharedTT = false;
      let didComputeUltraResult = false;

      if (canUseSharedTT) {
        // ---- Shared-TT + parallel root-PVS ----
        const backing = getUltraSharedTTBackingBestEffort();
        if (!backing) {
          await runUltraRootSplitFallback();
          usedSharedTT = false;
          didComputeUltraResult = true;
        } else {
          try {
            usedSharedTT = true;

            const workers: Worker[] = [];
            // Initialize workers with listeners armed first (avoid missing fast replies).
            const initDeadline = Math.min(deadlineMs, Date.now() + 2000);
            const initWaitMs = Math.max(1, initDeadline - Date.now());
            const readyPromises: Promise<boolean>[] = [];
            for (let i = 0; i < workerCount; i++) {
              const w = new Worker(new URL('./ai/ultraPvs.worker.ts', import.meta.url), { type: 'module' });
              workers.push(w);
              const wait = waitForType(w, 'ultraPvsReady', initWaitMs).then(msg => Boolean(msg && msg.type === 'ultraPvsReady'));
              readyPromises.push(wait);
              w.postMessage({ type: 'initSharedTT', backing });
            }

            const ready = await Promise.all(readyPromises);

            const activeWorkers: Worker[] = [];
            for (let i = 0; i < workers.length; i++) {
              const w = workers[i]!;
              if (!ready[i]) {
                w.terminate();
                continue;
              }
              activeWorkers.push(w);
            }

            if (activeWorkers.length === 0) {
              // If we couldn't bring up the shared pool, fall back to the root-split Ultra.
              usedSharedTT = false;
              await runUltraRootSplitFallback();
              didComputeUltraResult = true;
            } else {
              // Broadcast position once.
              const posPromises: Promise<boolean>[] = [];
              for (const w of activeWorkers) {
                const wait = waitForType(w, 'ultraPvsPositionReady', 500).then(msg => Boolean(msg && msg.type === 'ultraPvsPositionReady'));
                posPromises.push(wait);
                w.postMessage({ type: 'setPosition', state: ultraState });
              }
              await Promise.all(posPromises);

              let moveList: Move[] = movesOnly.slice();
              let bestMoveSoFar: Move = moveList[0]!;
              let bestScoreSoFar = 0;
              let bestDepthSoFar = 0;
              let totalNodes = 0;

              // Ultra wants to keep deepening until the deadline; lift the depth cap.
              const ultraMaxDepth = Math.max(maxDepth, 64);

              for (let depth = 1; depth <= ultraMaxDepth; depth++) {
                const now = Date.now();
                if (now >= deadlineMs) break;
                const depthDeadline = deadlineMs;

                // 1) Search PV move first (full window).
                const pvWorker = activeWorkers[0]!;
                const pvRes = await runRootMove(
                  pvWorker,
                  bestMoveSoFar,
                  depth,
                  -CONFIG.INFINITY,
                  CONFIG.INFINITY,
                  depthDeadline
                );
                if (!pvRes || !pvRes.completed) break;
                totalNodes += pvRes.nodes;

                let bestAtDepth = pvRes.score;
                let bestMoveAtDepth = bestMoveSoFar;
                let alpha = bestAtDepth;

                // 2) Search remaining moves at null-window in parallel.
                const others = moveList.filter(m => m !== bestMoveSoFar);
                const nullBeta = Math.min(CONFIG.INFINITY, alpha + 1);

                let next = 0;
                const nullResults: Array<{ move: Move; score: number; nodes: number; completed: boolean }> = [];

                const workerLoop = async (w: Worker): Promise<void> => {
                  while (true) {
                    const i = next++;
                    if (i >= others.length) return;
                    if (Date.now() >= depthDeadline) return;
                    const mv = others[i]!;
                    const r = await runRootMove(w, mv, depth, alpha, nullBeta, depthDeadline);
                    if (!r) return;
                    nullResults.push({ move: mv, score: r.score, nodes: r.nodes, completed: r.completed });
                  }
                };

                await Promise.all(activeWorkers.map(w => workerLoop(w)));

                // Collect + decide which moves need a full re-search.
                const failHigh = nullResults
                  .filter(r => r.completed && r.score > alpha)
                  .sort((a, b) => b.score - a.score);

                for (const r of nullResults) {
                  totalNodes += r.nodes;
                  if (!r.completed) {
                    // Ran out of time at this depth; keep previous best.
                    break;
                  }
                }

                // 3) Full-window re-search any fail-high moves (as time allows).
                for (const fh of failHigh) {
                  if (Date.now() >= depthDeadline) break;
                  const w = activeWorkers[0]!;
                  const full = await runRootMove(w, fh.move, depth, alpha, CONFIG.INFINITY, depthDeadline);
                  if (!full || !full.completed) break;
                  totalNodes += full.nodes;
                  if (full.score > bestAtDepth) {
                    bestAtDepth = full.score;
                    bestMoveAtDepth = fh.move;
                    alpha = bestAtDepth;
                  }
                }

                bestMoveSoFar = bestMoveAtDepth;
                bestScoreSoFar = bestAtDepth;
                bestDepthSoFar = depth;

                // Reorder PV to front for next depth.
                if (moveList[0] !== bestMoveSoFar) {
                  moveList = [bestMoveSoFar, ...moveList.filter(m => m !== bestMoveSoFar)];
                }

                if (bestScoreSoFar >= CONFIG.WIN_SCORE - 100) break;
                if (bestScoreSoFar <= CONFIG.LOSS_SCORE + 100) break;
              }

              for (const w of activeWorkers) w.terminate();

              // If we never completed even depth 1 (common symptom: worker crash / unsupported Atomics),
              // do NOT return a "depth=0,nodes=0" pseudo-result. Fall back to root-split Ultra.
              if (bestDepthSoFar <= 0 || totalNodes <= 0) {
                usedSharedTT = false;
                await runUltraRootSplitFallback();
                didComputeUltraResult = true;
              } else {
                result = {
                  completed: true,
                  score: bestScoreSoFar,
                  move: bestMoveSoFar,
                  depth: bestDepthSoFar,
                  nodes: totalNodes,
                };
                nodes = totalNodes;
                didComputeUltraResult = true;
              }
            }
          } catch {
            usedSharedTT = false;
            await runUltraRootSplitFallback();
            didComputeUltraResult = true;
          }
        }
      }

      if (!didComputeUltraResult) {
        await runUltraRootSplitFallback();
      }
    } else {
      if (predictedHit === true && ponderReplySession && ponderPredictedChildHash === board.hash.toString()) {
        usedReplySession = true;
        result = ponderReplySession.searchSlice(timeLimit);
      } else {
        result = findBestMove(board, player, timeLimit, maxDepth, nnueWeights, rootMoveFilter, ply1ReplyMoveFilter, ply2MoveFilter, scores, scoreToWin);
      }
      nodes = result.nodes ?? 0;
    }

    const ttStats = tt.getProbeStats();
    const reuseFromPrevPct = ttStats.hits > 0 ? ttStats.hitsPrevAge / ttStats.hits : 0;
    
    if (!result.move) {
      console.warn('[AI Worker] No move found; attempting generated fallback');
      const generated = generateAllMoves(board, player, { scores, scoreToWin });
      let fallback: Move | null = null;
      for (const m of generated) {
        if (isMoveLegal(board, m.move, player) && (rootMoveFilter === null || rootMoveFilter(m.move))) {
          fallback = m.move;
          break;
        }
      }

      if (!fallback) {
        console.warn('[AI Worker] No legal fallback exists after empty search result');
        clearActiveDihedral();
        return { type: 'result', move: null };
      }

      result = {
        completed: true,
        score: 0,
        move: fallback,
        depth: 0,
        nodes,
      };
    }

    const baseMove = result.move;
    if (!baseMove) {
      console.warn('[AI Worker] No move found after fallback attempts');
      clearActiveDihedral();
      return { type: 'result', move: null };
    }

    // Optional resignation: only when the existing search already returned a mate/terminal-coded loss.
    // No additional searching is performed.
    const reachedDepth = result.depth ?? 0;
    if (scoreToWin !== 0 && isMateCodedLossScore(result.score, reachedDepth, maxDepth)) {
      const winner = player === BLACK ? 'white' : 'black';
      clearActiveDihedral();
      resetPonderingState();
      return {
        type: 'result',
        resign: { winner, score: result.score, depth: reachedDepth },
        move: null,
      };
    }

    // Guard: never emit an illegal move (can happen in rare TT/collision or edge states).
    let chosenMove: Move = baseMove;
    if (!isMoveLegal(board, chosenMove, player) || (rootMoveFilter !== null && !rootMoveFilter(chosenMove))) {
      const generated = generateAllMoves(board, player, { scores, scoreToWin });
      let fallback: Move | null = null;
      for (const m of generated) {
        if (isMoveLegal(board, m.move, player) && (rootMoveFilter === null || rootMoveFilter(m.move))) {
          fallback = m.move;
          break;
        }
      }

      if (!fallback) {
        console.warn('[AI Worker] Search returned illegal move and no legal fallback exists', {
          illegal: moveToLogObject(chosenMove),
        });
        clearActiveDihedral();
        return { type: 'result', move: null };
      }

      console.warn('[AI Worker] Search returned illegal move; using fallback', {
        illegal: moveToLogObject(chosenMove),
        fallback: moveToLogObject(fallback),
      });
      chosenMove = fallback;
    }
    
    // Convert move to legacy format
    const positions = untransformPositions(moveToLegacy(chosenMove));
    
    const moveResult: MoveResult = {
      type: 'result',
      move: {
        action: chosenMove.action,
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
              bestMove: untransformLogMove(ponder.bestMove),
              replyNodes: ponder.replyNodes,
              replyTimeMs: ponder.replyTimeMs,
              replyBestDepth: ponder.replyBestDepth,
              replyBestScore: ponder.replyBestScore,
              replyBestMove: untransformLogMove(ponder.replyBestMove),
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
    
    // Reset per-move randomization after producing a move.
    clearActiveDihedral();

    // Clear ponder sessions after using them (next turn will start new pondering).
    resetPonderingState();
    return moveResult;
    
  } catch (error) {
    const err =
      error instanceof Error
        ? { message: error.message, stack: error.stack }
        : { message: String(error) };
    console.error('[AI Worker] Error finding move:', error);
    // Best-effort fallback: try to emit a legal move rather than forcing the main thread
    // into its naive recovery path.
    try {
      ensureActiveDihedral();
      const { board, player, openingPreset, moveIndex, scores, scoreToWin } = convertState(request.state);
      const rootMoveFilter = getOpeningRootMoveFilter(openingPreset, moveIndex, player);
      const generated = generateAllMoves(board, player, { scores, scoreToWin });
      let fallback: Move | null = null;
      for (const m of generated) {
        if (isMoveLegal(board, m.move, player) && (rootMoveFilter === null || rootMoveFilter(m.move))) {
          fallback = m.move;
          break;
        }
      }
      if (fallback) {
        const positions = untransformPositions(moveToLegacy(fallback));
        clearActiveDihedral();
        resetPonderingState();
        return {
          type: 'result',
          move: {
            action: fallback.action,
            positions,
            score: 0,
            depth: 0,
            nodes: 0,
            time: Date.now() - startTime,
          },
          error: {
            ...err,
            context: {
              phase: 'exception-fallback',
              openingPreset,
              moveIndex,
              player,
              ultraThink: request.config?.maxTime === 0,
            },
          },
        };
      }
    } catch (fallbackError) {
      console.error('[AI Worker] Error while generating fallback move:', fallbackError);
    }

    clearActiveDihedral();
    return {
      type: 'result',
      move: null,
      error: {
        ...err,
        context: {
          phase: 'exception-no-fallback',
          ultraThink: request.config?.maxTime === 0,
        },
      },
    };
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
