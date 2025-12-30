/**
 * AI Web Worker for Gomoku Rift
 * Uses the new optimized AI engine with alpha-beta search
 */

import {
  boardFrom2D,
  findBestMove,
  createSearchSession,
  moveToLegacy,
  getSearchStats,
  BLACK,
  WHITE,
  CONFIG,
} from './ai/index';
import type { Board, Color, Position } from './ai/types';
import type { SearchSession } from './ai/search';
import { runTacticalPuzzles } from './ai/puzzles';

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
  } | null;
}

interface PuzzlesResult {
  type: 'puzzlesResult';
  summary: ReturnType<typeof runTacticalPuzzles>;
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

// ---- Pondering (background search during human turn) ----
let ponderActive = false;
let ponderGeneration = 0;
let ponderSession: SearchSession | null = null;
let ponderSliceMs: number = 60;
let ponderMaxDepth: number = CONFIG.MAX_DEPTH;
let ponderDebug = false;

function stopPondering(): void {
  ponderActive = false;
  ponderSession = null;
  ponderGeneration++;
}

async function runPonderLoop(generation: number): Promise<void> {
  while (ponderActive && generation === ponderGeneration && ponderSession) {
    // Run a small slice so we can respond to stop/update quickly.
    ponderSession.searchSlice(ponderSliceMs);
    // Yield to the worker event loop.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
}

function startPondering(request: PonderStartRequest): void {
  const { board, player } = convertState(request.state);
  ponderSliceMs = Math.max(10, Math.min(200, Math.floor(request.config?.sliceMs ?? 60)));
  ponderMaxDepth = request.config?.maxDepth ?? CONFIG.MAX_DEPTH;
  ponderDebug = Boolean(request.config?.debug);

  stopPondering();
  ponderActive = true;
  ponderSession = createSearchSession(board, player, ponderMaxDepth);
  const myGen = ponderGeneration;

  if (ponderDebug) {
    console.log('[AI Worker] Ponder start', {
      sliceMs: ponderSliceMs,
      maxDepth: ponderMaxDepth,
      toMove: request.state.playerToMove ?? request.state.aiColor,
      stoneCount: board.blackCount + board.whiteCount,
    });
  }

  void runPonderLoop(myGen);
}

function updatePonderPosition(request: PositionUpdateRequest): void {
  if (!ponderSession) return;
  const { board, player } = convertState(request.state);
  ponderMaxDepth = request.config?.maxDepth ?? ponderMaxDepth;
  ponderSession.setPosition(board, player);

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
function handleFindBestMove(request: FindMoveRequest): MoveResult {
  const startTime = Date.now();
  
  try {
    // If pondering is active, stop it so we don't delay the real move search.
    stopPondering();

    const { board, player } = convertState(request.state);
    
    // Time allocation: in max-strength mode we always use the full default budget,
    // unless the caller explicitly overrides it.
    const requestedTime = request.config?.maxTime && request.config.maxTime > 0
      ? request.config.maxTime
      : CONFIG.DEFAULT_TIME;
    const timeLimit = Math.max(CONFIG.MIN_TIME, Math.min(CONFIG.MAX_TIME, Math.round(requestedTime)));
    
    const maxDepth = request.config?.maxDepth ?? CONFIG.MAX_DEPTH;
    
    if (request.config?.debug) {
      console.log('[AI Worker] Starting search', {
        timeLimit,
        maxDepth,
        stoneCount: board.blackCount + board.whiteCount,
      });
    }
    
    // Find best move
    const result = findBestMove(board, player, timeLimit, maxDepth);
    const stats = getSearchStats();
    
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
        nodes: stats.nodes,
        time: Date.now() - startTime,
      },
    };
    
    if (request.config?.debug) {
      console.log('[AI Worker] Move found', moveResult.move);
    }
    
    return moveResult;
    
  } catch (error) {
    console.error('[AI Worker] Error finding move:', error);
    return { type: 'result', move: null };
  }
}

// Web Worker message handler
self.onmessage = (e: MessageEvent) => {
  const request = e.data;

  if (request.type === 'ponderStart') {
    startPondering(request as PonderStartRequest);
    return;
  }

  if (request.type === 'ponderStop') {
    stopPondering();
    return;
  }

  if (request.type === 'positionUpdate') {
    updatePonderPosition(request as PositionUpdateRequest);
    return;
  }
  
  if (request.type === 'findBestMove') {
    const result = handleFindBestMove(request as FindMoveRequest);
    self.postMessage(result);
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
