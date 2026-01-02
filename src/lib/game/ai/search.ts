/**
 * Search Algorithm - Iterative Deepening Alpha-Beta with PVS
 * The core search engine for the AI
 */

import { CONFIG, BOARD_CELLS } from './constants';
import type { Board, Color, Move, SearchResult, ScoredMove, UndoInfo } from './types';
import { getOpponent, moveToKey, movesEqual, createReinforceMove, createSingleWinMove, createRiftMove } from './utils';
import { makeMove, unmakeMove, getWinnerAfterMove, validateReinforce, validateRift, getEmptyPositions } from './board';
import { evaluateSearch, isQuietPosition } from './evaluate';
import { generateAllMoves, generateTacticalMoves } from './moveGen';
import { orderMoves, updateKillerMoves, updateHistory, updateCounterMove, updateContinuationHistory, clearMoveOrdering, PVTable, isInterestingMove, getLMRReduction, getFutilityMargin } from './moveOrder';
import { getTranspositionTable, TranspositionTable } from './transposition';
import { hasCriticalThreat } from './threats';
import { createTimeState, shouldStopSearch } from './timeManager';
import { withTurn } from './zobrist';
import { threatSpaceSearch } from './tss';
import type { NnueWeights } from './nnue/weights';
import { NnueState } from './nnue/evaluator';
import { evaluateReinforceMove } from './synergy';

// Some legality constraints apply only at the ROOT and depend on non-board state
// (e.g. Long Pro move-index opening rules). Those constraints are enforced via `rootMoveFilter`,
// but the transposition table key only includes (board + ko + side to move).
// To prevent TT hits computed under a different root constraint context, salt the ROOT TT key
// when a root filter is active.
const ROOT_FILTER_TT_SALT = 0x9e3779b97f4a7c15n;
const PLY1_FILTER_TT_SALT = 0x243f6a8885a308d3n;

// Search statistics
let nodesSearched = 0;
let searchStartTime = 0;
let searchTimeLimit = 0;
let searchAborted = false;

interface SearchContext {
  board: Board;
  nnue: NnueState | null;
  /**
   * Optional root ordering hint (e.g. from TSS defense refutation). This should
   * NOT short-circuit search; it only influences move ordering at ply 0.
   */
  rootMoveHint: Move | null;
  /**
   * Optional root move filter. Applied ONLY at ply 0 to restrict the move set (e.g. opening rules).
   */
  rootMoveFilter: ((m: Move) => boolean) | null;
  /**
   * Optional salt applied to the TT key at ply 0 only.
   */
  rootTTSalt: bigint;
  /**
   * Optional move filter applied to ply 1 only (the opponent's immediate reply to root).
   * Used to model opening-dependent constraints on the opponent's *next* move.
   */
  ply1MoveFilter: ((m: Move) => boolean) | null;
  /**
   * Optional salt applied to the TT key at ply 1 only (when `ply1MoveFilter` is active).
   */
  ply1TTSalt: bigint;
}

function filterRootMoves(
  moves: ScoredMove[],
  filter: ((m: Move) => boolean) | null
): ScoredMove[] {
  if (!filter) return moves;
  return moves.filter(m => filter(m.move));
}

function generateFallbackRootMoves(
  board: Board,
  player: Color,
  filter: (m: Move) => boolean
): ScoredMove[] {
  const empties = getEmptyPositions(board);

  const out: ScoredMove[] = [];

  // 1) Reinforce moves: generate legal pairs from the full empty set so that opening filters
  // can still find legal options even when the normal candidate generator is too local.
  for (let i = 0; i < empties.length; i++) {
    const a = empties[i];
    for (let j = i + 1; j < empties.length; j++) {
      const b = empties[j];
      if (!validateReinforce(board, a, b, player)) continue;
      const move = createReinforceMove(a, b);
      if (!filter(move)) continue;
      const score = evaluateReinforceMove(board, a, b, player);
      out.push({ move, score, orderScore: score });
    }
  }

  // 2) Rift moves: include *all* legal rifts that pass the filter (not just top-K).
  // This prevents the filter from accidentally eliminating the truncated rift list.
  for (let pos = 0; pos < BOARD_CELLS; pos++) {
    if (!validateRift(board, pos, player)) continue;
    const move = createRiftMove(pos);
    if (!filter(move)) continue;
    // Keep neutral score; search will evaluate properly.
    out.push({ move, score: 0, orderScore: 0 });
  }

  out.sort((a, b) => {
    const as = a.orderScore ?? a.score;
    const bs = b.orderScore ?? b.score;
    return bs - as;
  });

  return out;
}

function getRootMoves(
  board: Board,
  player: Color,
  rootMoveFilter: ((m: Move) => boolean) | null
): ScoredMove[] {
  const moves = filterRootMoves(generateAllMoves(board, player), rootMoveFilter);
  if (moves.length > 0) return moves;
  if (!rootMoveFilter) return moves;
  return generateFallbackRootMoves(board, player, rootMoveFilter);
}

function applyMove(ctx: SearchContext, move: Move, player: Color): UndoInfo {
  const undo = makeMove(ctx.board, move, player);
  ctx.nnue?.applyMove(move, player, undo);
  return undo;
}

function revertMove(ctx: SearchContext, undo: UndoInfo, player: Color): void {
  ctx.nnue?.unapplyMove(undo.move, player, undo);
  unmakeMove(ctx.board, undo, player);
}

function rescoreTopMovesWithNnue(
  ctx: SearchContext,
  player: Color,
  moves: ScoredMove[],
  topK: number
): ScoredMove[] {
  if (!ctx.nnue) return moves;
  const K = Math.min(Math.max(0, topK), moves.length);
  if (K <= 1) return moves;

  const opponent = getOpponent(player);
  const rescored: { m: ScoredMove; order: number; idx: number }[] = [];

  for (let i = 0; i < K; i++) {
    const m = moves[i];
    const undo = applyMove(ctx, m.move, player);
    const childScore = evaluateSearch(ctx.board, opponent, ctx.nnue); // opponent-perspective
    revertMove(ctx, undo, player);
    // move value from current player perspective
    rescored.push({ m, order: -childScore, idx: i });
  }

  rescored.sort((a, b) => {
    const d = b.order - a.order;
    if (d !== 0) return d;
    // Stable-ish tie-breaker: preserve previous ordering within the rescored window.
    return a.idx - b.idx;
  });

  return [...rescored.map(r => r.m), ...moves.slice(K)];
}

/**
 * Check if time limit has been exceeded
 */
function isTimeUp(): boolean {
  if (searchTimeLimit <= 0) return false;
  return Date.now() - searchStartTime >= searchTimeLimit;
}

/**
 * Quiescence Search - Search tactical positions to stability
 */
function quiescence(
  ctx: SearchContext,
  player: Color,
  alpha: number,
  beta: number,
  depth: number
): number {
  nodesSearched++;
  
  if (isTimeUp()) {
    searchAborted = true;
    return 0;
  }
  
  // Stand-pat evaluation
  const standPat = evaluateSearch(ctx.board, player, ctx.nnue);
  
  if (depth <= 0) {
    return standPat;
  }
  
  // Beta cutoff
  if (standPat >= beta) {
    return beta;
  }
  
  // Improve alpha
  let localAlpha = alpha;
  if (standPat > localAlpha) {
    localAlpha = standPat;
  }
  
  // Check if position is quiet enough to stop
  if (isQuietPosition(ctx.board, player)) {
    return standPat;
  }
  
  // Generate only tactical moves
  const tacticalMoves = generateTacticalMoves(ctx.board, player);
  
  for (const { move, score } of tacticalMoves) {
    // Delta pruning - skip moves that can't possibly improve alpha
    if (standPat + score + 50000 < localAlpha) {
      continue;
    }
    
    const undoInfo = applyMove(ctx, move, player);
    const evalScore = -quiescence(ctx, getOpponent(player), -beta, -localAlpha, depth - 1);
    revertMove(ctx, undoInfo, player);
    
    if (searchAborted) return 0;
    
    if (evalScore >= beta) {
      return beta;
    }
    
    if (evalScore > localAlpha) {
      localAlpha = evalScore;
    }
  }
  
  return localAlpha;
}

/**
 * Alpha-Beta Search with Principal Variation Search
 */
function alphaBeta(
  ctx: SearchContext,
  player: Color,
  depth: number,
  alpha: number,
  beta: number,
  ply: number,
  tt: TranspositionTable,
  pvTable: PVTable,
  nullMoveAllowed: boolean = true,
  prevMove: Move | null = null
): SearchResult {
  nodesSearched++;
  
  // Time check
  if (isTimeUp()) {
    searchAborted = true;
    return { completed: false, score: 0, move: null };
  }
  
  // Transposition table probe
  const baseKey = withTurn(ctx.board.hash, player);
  const ttKey =
    ply === 0 && ctx.rootTTSalt !== 0n
      ? (baseKey ^ ctx.rootTTSalt)
      : ply === 1 && ctx.ply1TTSalt !== 0n
        ? (baseKey ^ ctx.ply1TTSalt)
        : baseKey;
  const [ttHit, ttScore, ttBestMove] = tt.tryGetScore(ttKey, depth, alpha, beta, ply);
  if (ttHit) {
    return { completed: true, score: ttScore, move: ttBestMove };
  }
  
  // Depth limit - enter quiescence
  if (depth <= 0) {
    const qScore = quiescence(ctx, player, alpha, beta, CONFIG.QUIESCENCE_DEPTH);
    return { completed: !searchAborted, score: qScore, move: null };
  }

  const opponent = getOpponent(player);

  // Lazily computed tactical danger flag (opponent has a critical threat).
  // We only pay for this check when we are about to apply an aggressive pruning/reduction.
  const rootUnderCriticalThreat = ply === 0 && hasCriticalThreat(ctx.board, opponent);
  let cachedDanger: boolean | null = ply === 0 ? rootUnderCriticalThreat : null;
  const isPruningSafe = (): boolean => {
    if (cachedDanger === null) {
      cachedDanger = hasCriticalThreat(ctx.board, opponent);
    }
    return !cachedDanger;
  };

  // Razoring: at shallow depth in quiet, non-dangerous positions, if static eval is far below alpha,
  // skip full move search and go directly to quiescence. This is a forward-pruning optimization.
  // Guardrails:
  // - Never at root
  // - Only at shallow depths
  // - Only when not under tactical danger (opponent critical threats)
  // - Only in quiet positions
  if (
    ply > 0 &&
    depth <= 2 &&
    beta < CONFIG.WIN_SCORE - 1000
  ) {
    const staticEval = evaluateSearch(ctx.board, player, ctx.nnue);
    const razorMargin = depth === 1 ? 500 : 900;
    if (staticEval + razorMargin <= alpha) {
      if (isPruningSafe() && isQuietPosition(ctx.board, player)) {
        const qScore = quiescence(ctx, player, alpha, beta, CONFIG.QUIESCENCE_DEPTH);
        return { completed: !searchAborted, score: qScore, move: null };
      }
    }
  }

  // Null-move pruning (NMP): if even giving the opponent an extra move doesn't prevent us
  // from reaching beta, we can safely prune this branch.
  //
  // Guardrails:
  // - Never at root (ply === 0)
  // - Only at sufficient depth
  // - Only when static eval is already >= beta (cheap precondition)
  // - Disabled when the opponent has a critical threat (tactically sharp)
  // - Disallow consecutive null moves via `nullMoveAllowed`
  if (
    nullMoveAllowed &&
    ply > 0 &&
    depth >= CONFIG.NMP_MIN_DEPTH &&
    beta < CONFIG.WIN_SCORE - 1000 // don't prune in (near-)mate windows
  ) {
    const staticEval = evaluateSearch(ctx.board, player, ctx.nnue);
    if (staticEval >= beta) {
      // Tactical guard: don't allow NMP when we may need an immediate defense.
      if (isPruningSafe()) {
        const nullDepth = depth - 1 - CONFIG.NMP_REDUCTION;
        if (nullDepth >= 0) {
          const result = alphaBeta(
            ctx,
            opponent,
            nullDepth,
            -beta,
            -beta + 1,
            ply + 1,
            tt,
            pvTable,
            false,
            null
          );
          const nullScore = -result.score;

          if (!result.completed) {
            return { completed: false, score: 0, move: null };
          }

          if (nullScore >= beta) {
            return { completed: true, score: nullScore, move: null };
          }
        }
      }
    }
  }
  
  // Generate and order moves
  const underCriticalThreat = rootUnderCriticalThreat;
  const orderingHint = ply === 0 && ctx.rootMoveHint ? ctx.rootMoveHint : ttBestMove;
  let moves = orderMoves(ctx.board, player, ply, orderingHint, prevMove);

  // Root-only move filtering (e.g. opening constraints).
  if (ply === 0 && ctx.rootMoveFilter) {
    moves = filterRootMoves(moves, ctx.rootMoveFilter);
    if (moves.length === 0) {
      moves = generateFallbackRootMoves(ctx.board, player, ctx.rootMoveFilter);
    }
  }

  // Ply-1-only move filtering: allow the root to correctly anticipate opening constraints
  // on the opponent's immediate reply (e.g. Long Pro).
  if (ply === 1 && ctx.ply1MoveFilter) {
    moves = filterRootMoves(moves, ctx.ply1MoveFilter);
    if (moves.length === 0) {
      moves = generateFallbackRootMoves(ctx.board, player, ctx.ply1MoveFilter);
    }
  }

  // Progressive widening at root: start with a smaller set of top moves and expand with depth.
  if (ply === 0) {
    const base = underCriticalThreat ? 24 : 12;
    const perDepth = underCriticalThreat ? 6 : 4;
    const limit = Math.min(moves.length, base + perDepth * Math.max(0, depth - 1));
    moves = moves.slice(0, limit);
  }

  // NNUE-assisted ordering at root: rescore the top-K moves with a cheap child NNUE eval.
  if (ply === 0 && ctx.nnue && CONFIG.NNUE_ORDER_RESCORE_TOP_K > 0) {
    moves = rescoreTopMovesWithNnue(ctx, player, moves, CONFIG.NNUE_ORDER_RESCORE_TOP_K);
  }
  
  if (moves.length === 0) {
    // No legal moves (shouldn't happen in Gomoku)
    return { completed: true, score: evaluateSearch(ctx.board, player, ctx.nnue), move: null };
  }
  
  let bestMove: Move | null = null;
  let bestScore = -CONFIG.INFINITY;
  // Root-only random tie-break among equal best scores.
  // Keeps inner nodes deterministic for stability/perf.
  let rootTieCount = 0;
  let flag: 'exact' | 'lower' | 'upper' = 'upper';
  let searchedMoves = 0;

  // Late Move Pruning (LMP) thresholds (very conservative).
  // Only applies in quiet, safe nodes at shallow depth for non-tactical moves.
  const lmpLimit =
    (ply > 0 && depth === 1) ? 12 :
    (ply > 0 && depth === 2) ? 16 :
    Infinity;
  const lmpNodeQuiet = lmpLimit !== Infinity && isPruningSafe() && isQuietPosition(ctx.board, player);

  // Singular-style extension heuristic (very conservative):
  // If the best move (usually TT-best / strongly ordered) clearly dominates by heuristic score,
  // extend it by 1 ply to stabilize PV and reduce horizon issues.
  const singularCandidate =
    ply > 0 &&
    depth >= 6 &&
    !underCriticalThreat &&
    isPruningSafe() &&
    ttBestMove !== null &&
    moves.length >= 2 &&
    moves[0].score >= moves[1].score + 200000;
  
  for (const { move, score: moveScore } of moves) {
    // Late Move Pruning: once we've searched enough moves at shallow depth in a quiet node,
    // prune remaining non-tactical moves.
    if (searchedMoves >= lmpLimit && lmpNodeQuiet) {
      const isCapture = move.action === 'rift';
      const givesCheck = isInterestingMove(ctx.board, move, player, moveScore);
      if (!isCapture && !givesCheck) {
        break;
      }
    }

    const undoInfo = applyMove(ctx, move, player);
    
    let score: number;

    // Incremental terminal check based on the move we just made.
    // This replaces expensive full-board `hasWon` scans at every node.
    const winner = getWinnerAfterMove(ctx.board, move, player);
    if (winner !== null) {
      // Use child-ply (ply + 1) so earlier wins are preferred.
      score = winner === player ? (CONFIG.WIN_SCORE - (ply + 1)) : (CONFIG.LOSS_SCORE + (ply + 1));
      revertMove(ctx, undoInfo, player);
      searchedMoves++;
    } else {
      const isCapture = move.action === 'rift';
      const givesCheck = isInterestingMove(ctx.board, move, player, moveScore);
      // Extensions:
      // - Threat extension: only at the frontier to avoid runaway depth in tactical lines.
      // - Singular-style extension: only for a clearly dominant TT best move, in safe/quiet positions.
      let extension = depth === 1 && givesCheck ? 1 : 0;
      if (
        extension === 0 &&
        searchedMoves === 0 &&
        singularCandidate &&
        movesEqual(move, ttBestMove)
      ) {
        extension = 1;
      }
      const fullChildDepth = depth - 1 + extension;

      // Futility pruning (very conservative):
      // Skip late, non-tactical moves at shallow depth when even the optimistic moveScore
      // cannot raise alpha by the margin.
      if (!underCriticalThreat && depth <= 2 && searchedMoves >= 8 && !isCapture && !givesCheck) {
        const margin = getFutilityMargin(depth);
        if (isPruningSafe() && moveScore + margin <= alpha) {
          revertMove(ctx, undoInfo, player);
          searchedMoves++;
          continue;
        }
      }
    
      // Principal Variation Search
      if (searchedMoves === 0) {
        // Full window search for first move (expected best move)
        const result = alphaBeta(
          ctx, opponent, fullChildDepth,
          -beta, -alpha, ply + 1, tt, pvTable, true, move
        );
        score = -result.score;
      } else {
        let reduction = getLMRReduction(searchedMoves, depth, isCapture, givesCheck);
        if (reduction > 0 && !isPruningSafe()) {
          reduction = 0;
        }
        const reducedDepth = Math.max(0, fullChildDepth - reduction);

        // Null window search for other moves
        let result = alphaBeta(
          ctx, opponent, reducedDepth,
          -alpha - 1, -alpha, ply + 1, tt, pvTable, true, move
        );
        score = -result.score;

        // If we reduced depth and the move looks promising, re-search at full depth.
        if (reduction > 0 && score > alpha && !searchAborted) {
          result = alphaBeta(
            ctx, opponent, fullChildDepth,
            -alpha - 1, -alpha, ply + 1, tt, pvTable, true, move
          );
          score = -result.score;
        }
        
        // Re-search with full window if failed high
        if (score > alpha && score < beta && !searchAborted) {
          result = alphaBeta(
            ctx, opponent, fullChildDepth,
            -beta, -alpha, ply + 1, tt, pvTable, true, move
          );
          score = -result.score;
        }
      }
      
      revertMove(ctx, undoInfo, player);
      searchedMoves++;
    }
    
    if (searchAborted) {
      return { completed: false, score: 0, move: null };
    }
    
    // Update best score
    if (score > bestScore) {
      bestScore = score;
      bestMove = move;
      if (ply === 0) rootTieCount = 1;
      
      if (score > alpha) {
        alpha = score;
        flag = 'exact';
        pvTable.update(ply, move);
        
        // Beta cutoff
        if (alpha >= beta) {
          flag = 'lower';
          
          // Update killer moves and history
          updateKillerMoves(ply, move);
          updateHistory(move, depth);
          updateCounterMove(prevMove, move);
          updateContinuationHistory(prevMove, move, depth);
          
          break;
        }
      }
    } else if (ply === 0 && score === bestScore && bestMove !== null) {
      // Reservoir sampling for unbiased selection among tied best moves.
      rootTieCount++;
      if (Math.random() < 1 / rootTieCount) {
        bestMove = move;
        pvTable.update(ply, move);
      }
    }
  }
  
  // Store in transposition table
  if (!searchAborted) {
    tt.store(ttKey, depth, bestScore, flag, bestMove, ply);
  }
  
  return {
    completed: !searchAborted,
    score: bestScore,
    move: bestMove,
  };
}

/**
 * Fixed-depth alpha-beta (PVS) with an explicit (alpha, beta) window.
 * Intended for Ultra's parallel root-PVS worker tasks.
 *
 * NOTE: This does NOT do iterative deepening; it runs exactly one depth.
 */
export function alphaBetaWindowed(
  board: Board,
  player: Color,
  depth: number,
  alpha: number,
  beta: number,
  timeLimitMs: number,
  tt: TranspositionTable = getTranspositionTable(),
  nnueWeights: NnueWeights | null = null,
  prevMove: Move | null = null,
  rootMoveFilter: ((m: Move) => boolean) | null = null
): SearchResult {
  // Initialize search state for this call.
  searchStartTime = Date.now();
  searchTimeLimit = Math.max(1, Math.floor(timeLimitMs));
  searchAborted = false;
  nodesSearched = 0;

  const nnue = nnueWeights ? NnueState.fromBoard(board, nnueWeights) : null;
  const ctx: SearchContext = {
    board,
    nnue,
    rootMoveHint: null,
    rootMoveFilter,
    rootTTSalt: rootMoveFilter ? ROOT_FILTER_TT_SALT : 0n,
    ply1MoveFilter: null,
    ply1TTSalt: 0n,
  };
  const pvTable = new PVTable();
  const res = alphaBeta(ctx, player, depth, alpha, beta, 0, tt, pvTable, true, prevMove);

  return {
    completed: res.completed,
    score: res.score,
    move: res.move,
    nodes: nodesSearched,
    depth,
  };
}

/**
 * Iterative Deepening Search
 * Always tracks "best move so far" to guarantee a valid move is returned
 */
export function iterativeDeepening(
  board: Board,
  player: Color,
  timeLimit: number,
  maxDepth: number = CONFIG.MAX_DEPTH,
  options?: {
    /**
     * By default we clear killer/history ordering at the start of each search.
     * For pondering and max-strength mode, it can be beneficial to preserve it.
     */
    preserveMoveOrdering?: boolean;
    /**
     * By default we increment TT age at the start of each search. For slice-based
     * pondering, you usually want to increment age only when the position changes.
     */
    preserveTTAge?: boolean;
    /**
     * Reuse a PV table across multiple slices of the same search.
     */
    pvTable?: PVTable;
    /**
     * Reuse a TT instance (defaults to global TT).
     */
    tt?: TranspositionTable;
    /**
     * Optional NNUE weights. When present, the search uses NNUE for leaf eval and (root) ordering.
     * When absent, search falls back to handcrafted evaluation.
     */
    nnueWeights?: NnueWeights | null;
    /**
     * Optional root move ordering hint. Used to search a known-good defensive refutation first,
     * while still allowing alpha-beta to pick a better second stone / line.
     */
    rootMoveHint?: Move | null;
    /**
     * Optional root move filter. Applied ONLY at ply 0.
     */
    rootMoveFilter?: (m: Move) => boolean;
    /**
     * Optional ply-1 move filter. Applied ONLY at ply 1 (opponent reply to root).
     * Used to model opening constraints on the opponent's immediate reply (Long Pro lookahead).
     */
    ply1MoveFilter?: (m: Move) => boolean;
  }
): SearchResult {
  // Initialize search state
  searchStartTime = Date.now();
  searchTimeLimit = timeLimit;
  searchAborted = false;
  nodesSearched = 0;

  const timeState = timeLimit > 0 ? createTimeState(timeLimit) : null;
  if (timeState) {
    // Keep `TimeState` aligned with the hard node-level time limit.
    timeState.hardLimit = timeLimit;
    timeState.canExtend = false;
  }
  
  const tt = options?.tt ?? getTranspositionTable();
  if (!options?.preserveTTAge) {
    tt.newSearch();
  }
  
  const pvTable = options?.pvTable ?? new PVTable();
  if (!options?.preserveMoveOrdering) {
    clearMoveOrdering();
  }

  const nnue = options?.nnueWeights ? NnueState.fromBoard(board, options.nnueWeights) : null;
  const rootMoveFilter = options?.rootMoveFilter ?? null;
  const ply1MoveFilter = options?.ply1MoveFilter ?? null;
  const ctx: SearchContext = {
    board,
    nnue,
    rootMoveHint: options?.rootMoveHint ?? null,
    rootMoveFilter,
    rootTTSalt: rootMoveFilter ? ROOT_FILTER_TT_SALT : 0n,
    ply1MoveFilter,
    ply1TTSalt: ply1MoveFilter ? PLY1_FILTER_TT_SALT : 0n,
  };
  
  // CRITICAL: Always have a valid move before starting search
  // This guarantees we never return null
  const allMoves = getRootMoves(board, player, ctx.rootMoveFilter);
  let bestMoveSoFar: Move | null = allMoves.length > 0 ? allMoves[0].move : null;
  let bestScoreSoFar = allMoves.length > 0 ? allMoves[0].score : 0;
  let bestDepthSoFar = 0;

  // If we have a root ordering hint (e.g. a known-good defensive refutation),
  // also seed it as "best so far" so that even a depth-1 timeout still plays it.
  const hinted = options?.rootMoveHint ?? null;
  if (hinted && bestMoveSoFar !== null) {
    const match = allMoves.find(m => movesEqual(m.move, hinted));
    if (match) {
      bestMoveSoFar = match.move;
      bestScoreSoFar = match.score;
    }
  }
  
  // If no moves at all (shouldn't happen), return early
  if (bestMoveSoFar === null) {
    return {
      completed: true,
      score: 0,
      move: null,
      depth: 0,
      nodes: 0,
    };
  }
  
  // Iterative deepening loop
  let lastScore = bestScoreSoFar;
  const baseWindow = 200000; // Aspiration window (tuned for this eval scale)

  for (let depth = 1; depth <= maxDepth; depth++) {
    // Aspiration window around last iteration score (reduces re-search work).
    let alpha: number = -CONFIG.INFINITY;
    let beta: number = CONFIG.INFINITY;
    if (depth > 1) {
      alpha = Math.max(-CONFIG.INFINITY, lastScore - baseWindow);
      beta = Math.min(CONFIG.INFINITY, lastScore + baseWindow);
    }

    let result: SearchResult = { completed: false, score: 0, move: null };
    let window = baseWindow;

    for (let attempt = 0; attempt < 3; attempt++) {
      result = alphaBeta(
        ctx, player, depth,
        alpha, beta,
        0, tt, pvTable, true
      );

      if (searchAborted) break;

      // Fail-low / fail-high => widen and retry.
      if (result.score <= alpha) {
        window *= 2;
        alpha = -CONFIG.INFINITY;
        beta = Math.min(CONFIG.INFINITY, result.score + window);
        continue;
      }
      if (result.score >= beta) {
        window *= 2;
        alpha = Math.max(-CONFIG.INFINITY, result.score - window);
        beta = CONFIG.INFINITY;
        continue;
      }

      break;
    }
    
    if (searchAborted) {
      // Use best move from previous completed iteration
      break;
    }
    
    if (result.completed && result.move !== null) {
      // Update best move so far
      bestMoveSoFar = result.move;
      bestScoreSoFar = result.score;
      bestDepthSoFar = depth;
      lastScore = result.score;
      
      // Early termination if found forced win
      if (result.score >= CONFIG.WIN_SCORE - 100) {
        break;
      }
      
      // Early termination if found forced loss (no point searching deeper)
      if (result.score <= CONFIG.LOSS_SCORE + 100) {
        break;
      }
    }
    
    // Stop deepening when the time manager says so.
    if (timeState && shouldStopSearch(timeState, lastScore)) {
      break;
    }
  }
  
  // Always return best move found (guaranteed non-null from initialization)
  return {
    completed: true,
    score: bestScoreSoFar,
    move: bestMoveSoFar,
    depth: bestDepthSoFar,
    nodes: nodesSearched,
  };
}

export interface SearchSession {
  /**
   * Run the search for up to `timeLimitMs` and return the best result found so far.
   * Subsequent calls will continue deepening from where the session left off.
   */
  searchSlice(timeLimitMs: number): SearchResult;
  /**
   * Replace the position and reset deepening state (TT/history are preserved).
   */
  setPosition(board: Board, player: Color): void;
  /**
   * Get the best result found so far without searching.
   */
  getBest(): SearchResult;
}

class SearchSessionImpl implements SearchSession {
  private board: Board;
  private player: Color;
  private maxDepth: number;
  private tt: TranspositionTable;
  private pvTable: PVTable;
  private nnueWeights: NnueWeights | null;
  private nnue: NnueState | null = null;
  private rootMoveFilter: ((m: Move) => boolean) | null;

  private bestMove: Move | null = null;
  private bestScore = 0;
  private bestDepth = 0;
  private lastScore = 0;
  private nextDepth = 1;

  constructor(
    board: Board,
    player: Color,
    maxDepth: number,
    tt: TranspositionTable,
    nnueWeights: NnueWeights | null,
    rootMoveFilter: ((m: Move) => boolean) | null
  ) {
    this.board = board;
    this.player = player;
    this.maxDepth = maxDepth;
    this.tt = tt;
    this.pvTable = new PVTable();
    this.nnueWeights = nnueWeights;
    this.rootMoveFilter = rootMoveFilter;
    this.resetForPosition();
  }

  private resetForPosition(): void {
    // Age the TT once per new position so entries from old positions become replaceable.
    this.tt.newSearch();
    this.pvTable.clear();

    this.nnue = this.nnueWeights ? NnueState.fromBoard(this.board, this.nnueWeights) : null;

    // Seed "best move so far" to guarantee non-null result.
    const moves = getRootMoves(this.board, this.player, this.rootMoveFilter);
    this.bestMove = moves.length > 0 ? moves[0].move : null;
    this.bestScore = moves.length > 0 ? moves[0].score : 0;
    this.bestDepth = 0;
    this.lastScore = this.bestScore;
    this.nextDepth = 1;
  }

  setPosition(board: Board, player: Color): void {
    this.board = board;
    this.player = player;
    this.resetForPosition();
  }

  getBest(): SearchResult {
    return {
      completed: true,
      score: this.bestScore,
      move: this.bestMove,
      depth: this.bestDepth,
      nodes: 0,
    };
  }

  searchSlice(timeLimitMs: number): SearchResult {
    if (this.bestMove === null) {
      return {
        completed: true,
        score: 0,
        move: null,
        depth: 0,
        nodes: 0,
      };
    }

    // Use iterativeDeepening, but continue from the session's nextDepth by running
    // depth-by-depth in this slice, reusing PV + move ordering + TT age.
    searchStartTime = Date.now();
    searchTimeLimit = timeLimitMs;
    searchAborted = false;
    nodesSearched = 0;

    const timeState = timeLimitMs > 0 ? createTimeState(timeLimitMs) : null;
    if (timeState) {
      timeState.hardLimit = timeLimitMs;
      timeState.canExtend = false;
    }

    const ctx: SearchContext = {
      board: this.board,
      nnue: this.nnue,
      rootMoveHint: null,
      rootMoveFilter: this.rootMoveFilter,
      rootTTSalt: this.rootMoveFilter ? ROOT_FILTER_TT_SALT : 0n,
      ply1MoveFilter: null,
      ply1TTSalt: 0n,
    };
    const baseWindow = 200000;

    for (let depth = this.nextDepth; depth <= this.maxDepth; depth++) {
      let alpha: number = -CONFIG.INFINITY;
      let beta: number = CONFIG.INFINITY;
      if (depth > 1) {
        alpha = Math.max(-CONFIG.INFINITY, this.lastScore - baseWindow);
        beta = Math.min(CONFIG.INFINITY, this.lastScore + baseWindow);
      }

      let result: SearchResult = { completed: false, score: 0, move: null };
      let window = baseWindow;

      for (let attempt = 0; attempt < 3; attempt++) {
        result = alphaBeta(
          ctx, this.player, depth,
          alpha, beta,
          0, this.tt, this.pvTable, true
        );

        if (searchAborted) break;

        if (result.score <= alpha) {
          window *= 2;
          alpha = -CONFIG.INFINITY;
          beta = Math.min(CONFIG.INFINITY, result.score + window);
          continue;
        }
        if (result.score >= beta) {
          window *= 2;
          alpha = Math.max(-CONFIG.INFINITY, result.score - window);
          beta = CONFIG.INFINITY;
          continue;
        }
        break;
      }

      if (searchAborted) {
        break;
      }

      if (result.completed && result.move !== null) {
        this.bestMove = result.move;
        this.bestScore = result.score;
        this.bestDepth = depth;
        this.lastScore = result.score;
        this.nextDepth = depth + 1;

        if (result.score >= CONFIG.WIN_SCORE - 100) break;
        if (result.score <= CONFIG.LOSS_SCORE + 100) break;
      }

      if (timeState && shouldStopSearch(timeState, this.lastScore)) {
        break;
      }
    }

    return {
      completed: true,
      score: this.bestScore,
      move: this.bestMove,
      depth: this.bestDepth,
      nodes: nodesSearched,
    };
  }
}

export function createSearchSession(
  board: Board,
  player: Color,
  maxDepth: number = CONFIG.MAX_DEPTH,
  tt: TranspositionTable = getTranspositionTable(),
  nnueWeights: NnueWeights | null = null,
  rootMoveFilter: ((m: Move) => boolean) | null = null
): SearchSession {
  return new SearchSessionImpl(board, player, maxDepth, tt, nnueWeights, rootMoveFilter);
}

/**
 * Find the best move with full search
 * Guarantees a valid move is always returned
 */
export function findBestMove(
  board: Board,
  player: Color,
  timeLimit: number = CONFIG.DEFAULT_TIME,
  maxDepth: number = CONFIG.MAX_DEPTH,
  nnueWeights: NnueWeights | null = null,
  rootMoveFilter: ((m: Move) => boolean) | null = null,
  ply1MoveFilter: ((m: Move) => boolean) | null = null
): SearchResult {
  const startMs = Date.now();
  // Quick check for obvious moves
  
  // 1. Check if we can win immediately
  const moves = getRootMoves(board, player, rootMoveFilter);
  
  // Safety: if no moves, return null (shouldn't happen in normal play)
  if (moves.length === 0) {
    return {
      completed: true,
      score: 0,
      move: null,
      depth: 0,
      nodes: 0,
    };
  }
  
  for (const { move } of moves) {
    const undo = makeMove(board, move, player);
    const winner = getWinnerAfterMove(board, move, player);
    unmakeMove(board, undo, player);

    if (winner === player) {
      return {
        completed: true,
        score: CONFIG.WIN_SCORE,
        move,
        depth: 1,
        nodes: moves.length,
      };
    }
  }
  
  function hasImmediateWinningSingleStoneMoveExhaustive(side: Color): boolean {
    // With the colinearity constraint (two reinforce stones cannot be on the same line
    // unless an opponent stone lies between them), any reinforce win must be attributable
    // to a SINGLE winning placement. A “two-stone-only” exact-5 is impossible.
    //
    // So we only need an exhaustive single-stone win check (Ko-respecting).
    const empties = getEmptyPositions(board); // Ko-respecting

    // Single-stone wins (legal only when they win).
    for (const pos of empties) {
      const mv = createSingleWinMove(pos);
      const undo = makeMove(board, mv, side);
      const winner = getWinnerAfterMove(board, mv, side);
      unmakeMove(board, undo, side);
      if (winner === side) return true;
    }

    return false;
  }

  function opponentHasImmediateWinningMove(): boolean {
    return hasImmediateWinningSingleStoneMoveExhaustive(opponent);
  }

  // 2. Threat Space Search (tactical prover)
  // Spend a slice of the budget trying to PROVE a forced win or find a forced defense.
  const opponent = getOpponent(player);

  // Root sanity: avoid moves that immediately lose (or allow an immediate opponent win),
  // even under very small time budgets where deep search may not complete.
  function sanitizeRootMove(result: SearchResult): SearchResult {
    if (!result.move) return result;
    // If an external source (e.g. TSS) produced a move outside the root filter, do NOT return it.
    // This can happen under small budgets where we might otherwise return immediately.
    if (rootMoveFilter && !rootMoveFilter(result.move)) {
      const fallback = moves[0]?.move ?? null;
      return { ...result, move: fallback };
    }

    const allowsImmediateLoss = (mv: Move): boolean => {
      const undo = makeMove(board, mv, player);
      const immediateWinner = getWinnerAfterMove(board, mv, player);

      // If we win immediately, do not second-guess it.
      if (immediateWinner === player) {
        unmakeMove(board, undo, player);
        return false;
      }
      // If our move immediately loses (possible for rift due to exact-5 trimming), reject it.
      if (immediateWinner !== null && immediateWinner !== player) {
        unmakeMove(board, undo, player);
        return true;
      }

      if (hasImmediateWinningSingleStoneMoveExhaustive(opponent)) {
        unmakeMove(board, undo, player);
        return true;
      }

      unmakeMove(board, undo, player);
      return false;
    };

    if (!allowsImmediateLoss(result.move)) return result;

    // Try alternatives (in movegen order) until we find one that doesn't lose immediately.
    for (const { move } of moves) {
      if (!move) continue;
      if (!allowsImmediateLoss(move)) {
        return { ...result, move };
      }
    }

    return result;
  }

  const tssBudget =
    timeLimit > 0
      ? Math.min(timeLimit, Math.max(150, Math.min(2500, Math.floor(timeLimit * 0.4))))
      : 2500;

  const getRemainingMs = (): number => {
    if (timeLimit <= 0) return 0;
    return timeLimit - (Date.now() - startMs);
  };

  const tssAttack = threatSpaceSearch(board, player, player, {
    timeLimitMs: Math.floor(tssBudget * 0.6),
    maxPlies: 10,
    maxAttackerMoves: 16,
    maxDefenderMoves: 24,
  });
  if (
    tssAttack.status === 'proven_win' &&
    tssAttack.move &&
    (rootMoveFilter === null || rootMoveFilter(tssAttack.move))
  ) {
    return sanitizeRootMove({
      completed: true,
      score: CONFIG.WIN_SCORE,
      move: tssAttack.move,
      depth: 0,
      nodes: tssAttack.nodes,
    });
  }
  
  // If we are under tactical threat, try to find a refutation quickly.
  // IMPORTANT: In Gomoku Rift, two-stone reinforces can create one-move wins even without
  // classic single-stone win squares (e.g., open-three can be immediate win by placing both ends).
  // So we also probe whether the opponent has a direct winning move.
  const underCriticalThreat = hasCriticalThreat(board, opponent);
  const underImmediateThreat = underCriticalThreat || opponentHasImmediateWinningMove();
  let rootMoveHint: Move | null = null;
  let rootMoveHintNodes = 0;

  if (underImmediateThreat) {
    const tssDefense = threatSpaceSearch(board, opponent, player, {
      timeLimitMs: Math.floor(tssBudget * 0.4),
      maxPlies: 10,
      maxAttackerMoves: 16,
      maxDefenderMoves: 32,
    });
    if (tssDefense.status === 'not_proven' && tssDefense.move) {
      // Defender found a refutation (within threat-space). Use it only as a root ordering hint,
      // so alpha-beta can still choose a stronger second stone / continuation.
      if (rootMoveFilter === null || rootMoveFilter(tssDefense.move)) {
        rootMoveHint = tssDefense.move;
        rootMoveHintNodes = tssDefense.nodes;
      }

      // For ultra-tiny budgets, returning the refutation immediately is still valuable.
      if (timeLimit <= 200) {
        return sanitizeRootMove({
          completed: true,
          score: 0,
          move: rootMoveHint ?? moves[0].move,
          depth: 0,
          nodes: tssDefense.nodes,
        });
      }
    }

    // Under threat: use FULL time and depth for defense (with hint ordering if available).
    const remainingMs = getRemainingMs();
    if (timeLimit > 0 && remainingMs <= 0) {
      return sanitizeRootMove({
        completed: true,
        score: 0,
        move: rootMoveHint ?? moves[0].move,
        depth: 0,
        nodes: rootMoveHint ? rootMoveHintNodes : 0,
      });
    }

    const result = iterativeDeepening(board, player, remainingMs, maxDepth, {
      preserveMoveOrdering: true,
      nnueWeights,
      rootMoveHint,
      rootMoveFilter: rootMoveFilter ?? undefined,
      ply1MoveFilter: ply1MoveFilter ?? undefined,
    });
    return sanitizeRootMove(result);
  }
  
  // Full search
  const remainingMs = getRemainingMs();
  if (timeLimit > 0 && remainingMs <= 0) {
    return sanitizeRootMove({
      completed: true,
      score: 0,
      move: moves[0].move,
      depth: 0,
      nodes: 0,
    });
  }

  const result = iterativeDeepening(board, player, remainingMs, maxDepth, {
    preserveMoveOrdering: true,
    nnueWeights,
    rootMoveFilter: rootMoveFilter ?? undefined,
    ply1MoveFilter: ply1MoveFilter ?? undefined,
  });
  return sanitizeRootMove(result);
}

/**
 * Get search statistics
 */
export function getSearchStats(): { nodes: number; time: number } {
  return {
    nodes: nodesSearched,
    time: Date.now() - searchStartTime,
  };
}

/**
 * Abort current search
 */
export function abortSearch(): void {
  searchAborted = true;
}

