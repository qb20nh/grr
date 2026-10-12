/**
 * Search Algorithm - Iterative Deepening Alpha-Beta with PVS
 * The core search engine for the AI
 */

import { CONFIG, BOARD_CELLS } from './constants';
import type { Board, CellIndex, Color, Move, SearchResult, ScoredMove, UndoInfo } from './types';
import { BLACK, WHITE, EMPTY } from './types';
import { getOpponent, moveToKey, movesEqual, createReinforceMove, createSingleWinMove, createRiftMove } from './utils';
import { applyScoringAndClear, makeMove, unmakeMove, getWinnerAfterMove, validateReinforce, validateRift, getEmptyPositions } from './board';
import { evaluateSearch, isQuietPosition, clampStaticScore } from './evaluate';
import { generateAllMoves, generateTacticalMoves } from './moveGen';
import { orderMoves, updateKillerMoves, updateHistory, updateCounterMove, updateContinuationHistory, clearMoveOrdering, PVTable, isInterestingMove, getLMRReduction, getFutilityMargin } from './moveOrder';
import { getTranspositionTable, TranspositionTable } from './transposition';
import { hasCriticalThreat, getSingleStoneWinningSquares, getBlockingMask, getImmediateMatchWinningMove } from './threats';
import { createTimeState, shouldStopSearch } from './timeManager';
import { withTurn } from './zobrist';
import { threatSpaceSearch } from './tss';
import type { NnueWeights } from './nnue/weights';
import { NnueState } from './nnue/evaluator';
import { createReinforceScorer } from './synergy';

// Search statistics
let nodesSearched = 0;
let searchStartTime = 0;
let searchTimeLimit = 0;
let searchAborted = false;

interface SearchContext {
  board: Board;
  nnue: NnueState | null;
  // Only canonical search positions enter this cache, never hypothetical helper mutations.
  evalCache: Map<bigint, number>;
  /** Expand the generated root set after a selective search reports a loss. */
  rootFullWidth: boolean;
  /**
   * Match score state (points). Mutated by `applyMove`/`revertMove`.
   */
  scoreBlack: number;
  scoreWhite: number;
  /**
   * Score target (0 = unlimited / play until exhaustion).
   */
  scoreToWin: number;
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
   * Optional move filter applied to ply 1 only (the opponent's immediate reply to root).
   * Used to model opening-dependent constraints on the opponent's *next* move.
   */
  ply1MoveFilter: ((m: Move) => boolean) | null;
  /**
   * Optional move filter applied to ply 2 only.
   * Used for early-turn constraints that span beyond ply 1 (e.g. "no rift for first 3 turns").
   */
  ply2MoveFilter: ((m: Move) => boolean) | null;
}

type SearchUndoInfo = UndoInfo & {
  scoredBy: Color | null;
  scoreDelta: number;
  cleared: CellIndex[] | null;
};

function restoreClearedStones(board: Board, cleared: CellIndex[], color: Color): void {
  for (const idx of cleared) {
    if (board.cells[idx] !== EMPTY) continue;
    board.cells[idx] = color;
    if (color === BLACK) board.blackCount++;
    else if (color === WHITE) board.whiteCount++;
  }
}

function getMatchWinnerFromScores(scoreBlack: number, scoreWhite: number, scoreToWin: number): Color | null {
  if (!Number.isFinite(scoreToWin) || scoreToWin <= 0) return null; // 0 = unlimited
  if (scoreBlack >= scoreToWin) return BLACK;
  if (scoreWhite >= scoreToWin) return WHITE;
  return null;
}

function getMatchWinner(ctx: SearchContext): Color | null {
  return getMatchWinnerFromScores(ctx.scoreBlack, ctx.scoreWhite, ctx.scoreToWin);
}

function scoreForMatchWinner(winner: Color, perspective: Color, winPly: number): number {
  // Use child-ply so earlier wins are preferred.
  return winner === perspective ? (CONFIG.WIN_SCORE - winPly) : (CONFIG.LOSS_SCORE + winPly);
}

const MASK_64 = (1n << 64n) - 1n;
const SCORE_HASH_K0 = 0x9e3779b97f4a7c15n;
const SCORE_HASH_M1 = 0xbf58476d1ce4e5b9n;
const SCORE_HASH_M2 = 0x94d049bb133111ebn;

function u32(n: number): bigint {
  return BigInt(n >>> 0);
}

function mix64(z: bigint): bigint {
  z &= MASK_64;
  z ^= z >> 30n;
  z = (z * SCORE_HASH_M1) & MASK_64;
  z ^= z >> 27n;
  z = (z * SCORE_HASH_M2) & MASK_64;
  z ^= z >> 31n;
  return z & MASK_64;
}

function matchScoreHash(scoreBlack: number, scoreWhite: number, scoreToWin: number): bigint {
  // Include match state in the TT key to prevent transpositions across different scores.
  // We intentionally keep this 64-bit so it composes with the 64-bit Zobrist hash.
  const packed = (u32(scoreBlack) | (u32(scoreWhite) << 32n)) ^ (u32(scoreToWin) * SCORE_HASH_K0);
  return mix64(packed);
}

function pointValue(scoreToWin: number): number {
  // Conservative scaling: points matter, but don't swamp all tactical/positional factors.
  if (!Number.isFinite(scoreToWin) || scoreToWin <= 0) return 0;
  return Math.floor(CONFIG.WIN_SCORE / (Math.max(1, scoreToWin) * 4));
}

function evaluateWithMatch(ctx: SearchContext, player: Color): number {
  let base: number;
  if (ctx.nnue) {
    base = evaluateSearch(ctx.board, player, ctx.nnue);
  } else {
    // Search-local: board + ko + perspective determine the handcrafted value.
    // Match points are added below, so scoring transpositions remain distinct.
    const key = withTurn(ctx.board.hash, player);
    const cached = ctx.evalCache.get(key);
    if (cached !== undefined) base = cached;
    else {
      base = evaluateSearch(ctx.board, player, null);
      if (ctx.evalCache.size >= 16384) ctx.evalCache.clear();
      ctx.evalCache.set(key, base);
    }
  }
  if (ctx.scoreToWin === 0) return base;
  const pv = pointValue(ctx.scoreToWin);
  if (pv === 0) return base;

  // Convert (blackScore - whiteScore) into player-perspective.
  const diff = player === BLACK ? (ctx.scoreBlack - ctx.scoreWhite) : (ctx.scoreWhite - ctx.scoreBlack);
  return clampStaticScore(base + diff * pv);
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
  const scorer = createReinforceScorer(board, player, getBlockingMask(board, player));

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
      const score = scorer.pair(a, b);
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
  rootMoveFilter: ((m: Move) => boolean) | null,
  match?: { scores: { black: number; white: number }; scoreToWin: number }
): ScoredMove[] {
  const moves = filterRootMoves(generateAllMoves(board, player, match), rootMoveFilter);
  if (moves.length > 0) return moves;
  if (!rootMoveFilter) return moves;
  return generateFallbackRootMoves(board, player, rootMoveFilter);
}

function applyMove(ctx: SearchContext, move: Move, player: Color): SearchUndoInfo {
  const undo = makeMove(ctx.board, move, player) as SearchUndoInfo;
  ctx.nnue?.applyMove(move, player, undo);

  const scoring = applyScoringAndClear(ctx.board, move, player);
  undo.scoredBy = scoring.scoredBy;
  undo.scoreDelta = scoring.points;
  undo.cleared = scoring.cleared;

  if (scoring.scoredBy !== null && scoring.points > 0) {
    if (scoring.cleared) ctx.nnue?.removeStones(scoring.cleared, scoring.scoredBy);
    if (scoring.scoredBy === BLACK) ctx.scoreBlack += scoring.points;
    else if (scoring.scoredBy === WHITE) ctx.scoreWhite += scoring.points;
  }

  return undo;
}

function revertMove(ctx: SearchContext, undo: SearchUndoInfo, player: Color): void {
  // Restore cleared stones BEFORE unmaking the base move so counts end up consistent.
  if (undo.scoredBy !== null && undo.scoreDelta > 0) {
    if (undo.scoredBy === BLACK) ctx.scoreBlack -= undo.scoreDelta;
    else if (undo.scoredBy === WHITE) ctx.scoreWhite -= undo.scoreDelta;
    if (undo.cleared) {
      restoreClearedStones(ctx.board, undo.cleared, undo.scoredBy);
      ctx.nnue?.restoreStones(undo.cleared, undo.scoredBy);
    }
  }

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
    const childScore = evaluateWithMatch(ctx, opponent); // opponent-perspective
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
  depth: number,
  ply: number
): number {
  nodesSearched++;
  
  if (isTimeUp()) {
    searchAborted = true;
    return 0;
  }

  const winnerNow = getMatchWinner(ctx);
  if (winnerNow !== null) {
    return scoreForMatchWinner(winnerNow, player, ply);
  }

  // Count every scored line: one stone or a legal pair may win several points.
  const ownScore = player === BLACK ? ctx.scoreBlack : ctx.scoreWhite;
  if (ctx.scoreToWin > 0 && (ownScore + 1 >= ctx.scoreToWin
      ? getSingleStoneWinningSquares(ctx.board, player).length > 0
      : getImmediateMatchWinningMove(ctx.board, player, ctx.scoreToWin - ownScore) !== null)) {
    return scoreForMatchWinner(player, player, ply + 1);
  }
  
  if (depth <= 0) {
    return evaluateWithMatch(ctx, player);
  }
  
  // Passing is not a legal defense against an immediate scoring threat.
  const mustDefend = getSingleStoneWinningSquares(ctx.board, getOpponent(player), 'ignoreKo').length > 0;
  // A forced reply cannot use stand pat; avoid expensive fork evaluation that
  // would be discarded at these nodes.
  const standPat = mustDefend ? -CONFIG.INFINITY : evaluateWithMatch(ctx, player);
  if (!mustDefend && standPat >= beta) {
    return beta;
  }
  
  // Improve alpha
  let localAlpha = alpha;
  if (!mustDefend && standPat > localAlpha) {
    localAlpha = standPat;
  }
  // Generate only tactical moves
  const tacticalMoves = generateTacticalMoves(ctx.board, player, {
    scores: { black: ctx.scoreBlack, white: ctx.scoreWhite },
    scoreToWin: ctx.scoreToWin,
  });
  const opponentScore = player === BLACK ? ctx.scoreWhite : ctx.scoreBlack;
  if (tacticalMoves.length === 0) {
    return mustDefend && ctx.scoreToWin > 0 && (opponentScore + 1 >= ctx.scoreToWin ||
      getImmediateMatchWinningMove(ctx.board, getOpponent(player), ctx.scoreToWin - opponentScore, 'ignoreKo') !== null)
      ? scoreForMatchWinner(getOpponent(player), player, ply + 2)
      : mustDefend ? evaluateWithMatch(ctx, player) : standPat;
  }
  
  for (const { move } of tacticalMoves) {
    // A low ordering score does not bound the value of a forcing attack.
    const undoInfo = applyMove(ctx, move, player);
    const winner = getMatchWinner(ctx);
    const evalScore =
      winner !== null
        ? scoreForMatchWinner(winner, player, ply + 1)
        : -quiescence(ctx, getOpponent(player), -beta, -localAlpha, depth - 1, ply + 1);
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
  const baseKey =
    withTurn(ctx.board.hash, player) ^
    matchScoreHash(ctx.scoreBlack, ctx.scoreWhite, ctx.scoreToWin);
  // Callback filters are not represented in the position hash. Even ancestors of
  // a filtered ply have different minimax values. Only use move hints until all
  // pending constraints have expired; never cache their scores under a common key.
  const constrained = (ply === 0 && ctx.rootMoveFilter !== null) ||
    (ply <= 1 && ctx.ply1MoveFilter !== null) || (ply <= 2 && ctx.ply2MoveFilter !== null);
  const [ttHit, ttScore, ttBestMove] = constrained
    ? [false, 0, tt.getBestMove(baseKey)] as const
    : tt.tryGetScore(baseKey, depth, alpha, beta, ply);
  if (ttHit) {
    return { completed: true, score: ttScore, move: ttBestMove };
  }
  
  // Depth limit - enter quiescence
  if (depth <= 0 && !constrained) {
    const qScore = quiescence(ctx, player, alpha, beta, CONFIG.QUIESCENCE_DEPTH, ply);
    return { completed: !searchAborted, score: qScore, move: null };
  }
  if (depth <= 0) depth = 1;

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
    !constrained &&
    depth <= 2 &&
    beta < CONFIG.WIN_SCORE - 1000
  ) {
    const staticEval = evaluateWithMatch(ctx, player);
    const razorMargin = depth === 1 ? 500 : 900;
    if (staticEval + razorMargin <= alpha) {
      if (isPruningSafe() && isQuietPosition(ctx.board, player)) {
        const qScore = quiescence(ctx, player, alpha, beta, CONFIG.QUIESCENCE_DEPTH, ply);
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
    !constrained &&
    ctx.board.koPosition === null &&
    ply > 0 &&
    depth >= CONFIG.NMP_MIN_DEPTH &&
    beta < CONFIG.WIN_SCORE - 1000 // don't prune in (near-)mate windows
  ) {
    const staticEval = evaluateWithMatch(ctx, player);
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
  let moves = orderMoves(ctx.board, player, ply, orderingHint, prevMove, {
    scores: { black: ctx.scoreBlack, white: ctx.scoreWhite },
    scoreToWin: ctx.scoreToWin,
  });

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

  // Ply-2-only move filtering: used for early-turn constraints that need one more ply of lookahead.
  if (ply === 2 && ctx.ply2MoveFilter) {
    moves = filterRootMoves(moves, ctx.ply2MoveFilter);
    if (moves.length === 0) {
      moves = generateFallbackRootMoves(ctx.board, player, ctx.ply2MoveFilter);
    }
  }

  // Progressive widening at root: start with a smaller set of top moves and expand with depth.
  if (ply === 0 && !ctx.rootFullWidth &&
      getSingleStoneWinningSquares(ctx.board, opponent, 'ignoreKo').length === 0) {
    const base = underCriticalThreat ? 24 : 12;
    const perDepth = underCriticalThreat ? 6 : 4;
    const limit = Math.min(moves.length, base + perDepth * Math.max(0, depth - 1));
    moves = moves.filter((m, index) => index < limit || m.move.action === 'rift');
  }

  // NNUE-assisted ordering at root: rescore the top-K moves with a cheap child NNUE eval.
  if (ply === 0 && ctx.nnue && CONFIG.NNUE_ORDER_RESCORE_TOP_K > 0) {
    moves = rescoreTopMovesWithNnue(ctx, player, moves, CONFIG.NNUE_ORDER_RESCORE_TOP_K);
  }
  
  if (moves.length === 0) {
    // No legal moves (shouldn't happen in Gomoku)
    return { completed: true, score: evaluateWithMatch(ctx, player), move: null };
  }
  
  let bestMove: Move | null = null;
  let bestScore = -CONFIG.INFINITY;
  let flag: 'exact' | 'lower' | 'upper' = 'upper';
  let searchedMoves = 0;

  // Late Move Pruning (LMP) thresholds (very conservative).
  // Only applies in quiet, safe nodes at shallow depth for non-tactical moves.
  const lmpLimit =
    (ply > 0 && depth === 1) ? 12 :
    (ply > 0 && depth === 2) ? 16 :
    Infinity;
  const lmpNodeQuiet = lmpLimit !== Infinity && isPruningSafe() && isQuietPosition(ctx.board, player);

  // Read danger on the parent board, before any child move mutates it.
  const pruningSafe = isPruningSafe();

  
  for (const { move, score: moveScore } of moves) {
    // Late Move Pruning: once we've searched enough moves at shallow depth in a quiet node,
    // prune remaining non-tactical moves.
    if (searchedMoves >= lmpLimit && lmpNodeQuiet) {
      const isCapture = move.action === 'rift';
      const givesCheck = isInterestingMove(ctx.board, move, player, moveScore);
      if (!isCapture && !givesCheck) {
        continue;
      }
    }

    // Futility compares a position value with alpha, never a move-ordering
    // bonus. Apply it only to quiet non-PV nodes, while the parent board is
    // still intact; root alternatives always receive a real search.
    if (ply > 0 && depth <= 2 && searchedMoves >= 8 && beta - alpha <= 1 &&
        lmpNodeQuiet && move.action !== 'rift' && !isInterestingMove(ctx.board, move, player, moveScore) &&
        evaluateWithMatch(ctx, player) + getFutilityMargin(depth) <= alpha) {
      continue;
    }

    const undoInfo = applyMove(ctx, move, player);
    
    let score: number;

    // Terminal check: match ends when a side reaches `scoreToWin` points.
    const winner = getMatchWinner(ctx);
    if (winner !== null) {
      score = scoreForMatchWinner(winner, player, ply + 1);
      revertMove(ctx, undoInfo, player);
      searchedMoves++;
    } else {
      const isCapture = move.action === 'rift';
      const givesCheck = isInterestingMove(ctx.board, move, player, moveScore);
      // Tactical continuations are handled by the bounded quiescence search.
      // Extending every frontier threat keeps depth at 1 indefinitely in rift cycles.
      const fullChildDepth = depth - 1;

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
        if (reduction > 0 && !pruningSafe) {
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
      // Only fully searched siblings have reached bestMove. Preserve their
      // root choice for an interrupted first iteration, never the aborted child.
      return { completed: false, score: bestMove ? bestScore : 0,
        move: ply === 0 ? bestMove : null };
    }
    
    // Update best score
    if (score > bestScore) {
      bestScore = score;
      bestMove = move;
      
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
    }
  }
  
  // Store in transposition table
  if (!searchAborted && !constrained) {
    tt.store(baseKey, depth, bestScore, flag, bestMove, ply);
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
  rootMoveFilter: ((m: Move) => boolean) | null = null,
  ply1MoveFilter: ((m: Move) => boolean) | null = null,
  ply2MoveFilter: ((m: Move) => boolean) | null = null,
  scores: { black: number; white: number } = { black: 0, white: 0 },
  scoreToWin: number = 1
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
    evalCache: new Map(),
    rootFullWidth: false,
    scoreBlack: scores.black,
    scoreWhite: scores.white,
    scoreToWin,
    rootMoveHint: null,
    rootMoveFilter,
    ply1MoveFilter,
    ply2MoveFilter,
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
    /**
     * Optional ply-2 move filter. Applied ONLY at ply 2.
     */
    ply2MoveFilter?: (m: Move) => boolean;
    /**
     * Match score state (points). Defaults to 0-0.
     */
    scores?: { black: number; white: number };
    /**
     * Score target (0 = unlimited). Defaults to 1.
     */
    scoreToWin?: number;
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
  const ply2MoveFilter = options?.ply2MoveFilter ?? null;
  const ctx: SearchContext = {
    board,
    nnue,
    evalCache: new Map(),
    rootFullWidth: false,
    scoreBlack: options?.scores?.black ?? 0,
    scoreWhite: options?.scores?.white ?? 0,
    scoreToWin: options?.scoreToWin ?? 1,
    rootMoveHint: options?.rootMoveHint ?? null,
    rootMoveFilter,
    ply1MoveFilter,
    ply2MoveFilter,
  };
  
  // CRITICAL: Always have a valid move before starting search
  // This guarantees we never return null
  const allMoves = getRootMoves(board, player, ctx.rootMoveFilter, {
    scores: { black: ctx.scoreBlack, white: ctx.scoreWhite },
    scoreToWin: ctx.scoreToWin,
  });
  let bestMoveSoFar: Move | null = allMoves.length > 0 ? allMoves[0].move : null;
  // Move-ordering bonuses can exceed mate scores and are not position values.
  let bestScoreSoFar = evaluateWithMatch(ctx, player);
  let bestDepthSoFar = 0;

  // If we have a root ordering hint (e.g. a known-good defensive refutation),
  // also seed it as "best so far" so that even a depth-1 timeout still plays it.
  const hinted = options?.rootMoveHint ?? null;
  if (hinted && bestMoveSoFar !== null) {
    const match = allMoves.find(m => movesEqual(m.move, hinted));
    if (match) {
      bestMoveSoFar = match.move;
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
      // A completed iteration remains authoritative. Before the first one
      // finishes, prefer a searched root child over the heuristic-only fallback.
      if (bestDepthSoFar === 0 && result.move !== null) {
        bestMoveSoFar = result.move;
        bestScoreSoFar = result.score;
      }
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
      
      // A loss in a selectively widened tree is not a proof that every root
      // alternative loses. Expand candidates and keep looking within the budget.
      if (result.score <= CONFIG.LOSS_SCORE + 100) {
        ctx.rootFullWidth = true;
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
  setPosition(
    board: Board,
    player: Color,
    rootMoveFilter?: ((m: Move) => boolean) | null,
    ply1MoveFilter?: ((m: Move) => boolean) | null,
    ply2MoveFilter?: ((m: Move) => boolean) | null,
    scores?: { black: number; white: number },
    scoreToWin?: number
  ): void;
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
  private evalCache = new Map<bigint, number>();
  private rootFullWidth = false;
  private scoreBlack: number;
  private scoreWhite: number;
  private scoreToWin: number;
  private rootMoveFilter: ((m: Move) => boolean) | null;
  private ply1MoveFilter: ((m: Move) => boolean) | null;
  private ply2MoveFilter: ((m: Move) => boolean) | null;

  private bestMove: Move | null = null;
  private bestScore = 0;
  private bestDepth = 0;
  private hasPartialResult = false;
  private lastScore = 0;
  private nextDepth = 1;

  constructor(
    board: Board,
    player: Color,
    maxDepth: number,
    tt: TranspositionTable,
    nnueWeights: NnueWeights | null,
    rootMoveFilter: ((m: Move) => boolean) | null,
    ply1MoveFilter: ((m: Move) => boolean) | null,
    ply2MoveFilter: ((m: Move) => boolean) | null,
    scores: { black: number; white: number },
    scoreToWin: number
  ) {
    this.board = board;
    this.player = player;
    this.maxDepth = maxDepth;
    this.tt = tt;
    this.pvTable = new PVTable();
    this.nnueWeights = nnueWeights;
    this.scoreBlack = scores.black;
    this.scoreWhite = scores.white;
    this.scoreToWin = scoreToWin;
    this.rootMoveFilter = rootMoveFilter;
    this.ply1MoveFilter = ply1MoveFilter;
    this.ply2MoveFilter = ply2MoveFilter;
    this.resetForPosition();
  }

  private resetForPosition(): void {
    // Age the TT once per new position so entries from old positions become replaceable.
    this.tt.newSearch();
    this.pvTable.clear();
    this.evalCache.clear();
    this.rootFullWidth = false;

    this.nnue = this.nnueWeights ? NnueState.fromBoard(this.board, this.nnueWeights) : null;

    // Seed "best move so far" to guarantee non-null result.
    const moves = getRootMoves(this.board, this.player, this.rootMoveFilter, {
      scores: { black: this.scoreBlack, white: this.scoreWhite },
      scoreToWin: this.scoreToWin,
    });
    this.bestMove = moves.length > 0 ? moves[0].move : null;
    this.bestScore = evaluateSearch(this.board, this.player, this.nnue);
    this.bestScore = clampStaticScore(this.bestScore +
      (this.player === BLACK ? this.scoreBlack - this.scoreWhite : this.scoreWhite - this.scoreBlack) * pointValue(this.scoreToWin));
    this.bestDepth = 0;
    this.hasPartialResult = false;
    this.lastScore = this.bestScore;
    this.nextDepth = 1;
  }

  setPosition(
    board: Board,
    player: Color,
    rootMoveFilter?: ((m: Move) => boolean) | null,
    ply1MoveFilter?: ((m: Move) => boolean) | null,
    ply2MoveFilter?: ((m: Move) => boolean) | null,
    scores?: { black: number; white: number },
    scoreToWin?: number
  ): void {
    this.board = board;
    this.player = player;
    if (rootMoveFilter !== undefined) this.rootMoveFilter = rootMoveFilter;
    if (ply1MoveFilter !== undefined) this.ply1MoveFilter = ply1MoveFilter;
    if (ply2MoveFilter !== undefined) this.ply2MoveFilter = ply2MoveFilter;
    if (scores !== undefined) {
      this.scoreBlack = scores.black;
      this.scoreWhite = scores.white;
    }
    if (scoreToWin !== undefined) {
      this.scoreToWin = scoreToWin;
    }
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
      evalCache: this.evalCache,
      rootFullWidth: this.rootFullWidth,
      scoreBlack: this.scoreBlack,
      scoreWhite: this.scoreWhite,
      scoreToWin: this.scoreToWin,
      rootMoveHint: null,
      rootMoveFilter: this.rootMoveFilter,
      ply1MoveFilter: this.ply1MoveFilter,
      ply2MoveFilter: this.ply2MoveFilter,
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
        if (this.bestDepth === 0 && result.move !== null &&
            (!this.hasPartialResult || result.score > this.bestScore)) {
          this.bestMove = result.move;
          this.bestScore = result.score;
          this.hasPartialResult = true;
        }
        break;
      }

      if (result.completed && result.move !== null) {
        this.bestMove = result.move;
        this.bestScore = result.score;
        this.bestDepth = depth;
        this.lastScore = result.score;
        this.nextDepth = depth + 1;

        if (result.score >= CONFIG.WIN_SCORE - 100) break;
        if (result.score <= CONFIG.LOSS_SCORE + 100) {
          ctx.rootFullWidth = true;
          this.rootFullWidth = true;
        }
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
  rootMoveFilter: ((m: Move) => boolean) | null = null,
  ply1MoveFilter: ((m: Move) => boolean) | null = null,
  ply2MoveFilter: ((m: Move) => boolean) | null = null,
  scores: { black: number; white: number } = { black: 0, white: 0 },
  scoreToWin: number = 1
): SearchSession {
  return new SearchSessionImpl(board, player, maxDepth, tt, nnueWeights, rootMoveFilter, ply1MoveFilter, ply2MoveFilter, scores, scoreToWin);
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
  ply1MoveFilter: ((m: Move) => boolean) | null = null,
  ply2MoveFilter: ((m: Move) => boolean) | null = null,
  scores: { black: number; white: number } = { black: 0, white: 0 },
  scoreToWin: number = 1,
  options?: {
    tt?: TranspositionTable;
    /**
     * When true, keep killer/history move ordering between calls. This is the default behavior
     * for the baseline engine.
     */
    preserveMoveOrdering?: boolean;
    /**
     * When true, do not age the TT for this search (advanced; default is to age once per call).
     */
    preserveTTAge?: boolean;
    /**
     * Optional root ordering hint. This does not force the move; it seeds the PV so even a tiny
     * budget tends to play it, and it becomes the PV move searched first.
     */
    rootMoveHint?: Move | null;
  }
): SearchResult {
  const startMs = Date.now();
  // Quick check for obvious moves
  
  // 1. Check if we can win immediately
  const moves = getRootMoves(board, player, rootMoveFilter, { scores, scoreToWin });
  
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
  
  const opponent = getOpponent(player);

  const quickCtx: SearchContext = {
    board,
    nnue: null, // NNUE disabled (handcrafted eval only)
    evalCache: new Map(),
    rootFullWidth: false,
    scoreBlack: scores.black,
    scoreWhite: scores.white,
    scoreToWin,
    rootMoveHint: null,
    rootMoveFilter: null,
    ply1MoveFilter: null,
    ply2MoveFilter: null,
  };

  function sideHasImmediateMatchWinningMove(
    side: Color,
    filter: ((m: Move) => boolean) | null
  ): boolean {
    if (scoreToWin === 0) return false;
    const sideScore = side === BLACK ? quickCtx.scoreBlack : quickCtx.scoreWhite;
    if (filter === null && sideScore + 1 >= scoreToWin) {
      // Legal pair placements cannot extend each other's line without an enemy
      // shield between them. Any scoring pair therefore has a scoring single.
      // A rift only awards points to the removed color, never to its mover.
      return getSingleStoneWinningSquares(board, side).length > 0;
    }
    const candidates = getRootMoves(board, side, filter, {
      scores: { black: quickCtx.scoreBlack, white: quickCtx.scoreWhite },
      scoreToWin: quickCtx.scoreToWin,
    });
    for (const { move } of candidates) {
      const undo = applyMove(quickCtx, move, side);
      const winner = getMatchWinner(quickCtx);
      revertMove(quickCtx, undo, side);
      if (winner === side) return true;
    }
    return false;
  }

  // 1. Check if we can end the match immediately.
  if (scoreToWin !== 0) {
    for (const { move } of moves) {
      const undo = applyMove(quickCtx, move, player);
      const winner = getMatchWinner(quickCtx);
      revertMove(quickCtx, undo, player);

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
  }

  // 2. Threat Space Search (tactical prover)
  // Spend a slice of the budget trying to PROVE a forced win or find a forced defense.

  // Root sanity: avoid moves that immediately lose (or allow an immediate opponent win),
  // even under very small time budgets where deep search may not complete.
  function sanitizeRootMove(result: SearchResult): SearchResult {
    if (!result.move) return result;
    const replacement = (move: Move | null): SearchResult => {
      if (!move) return { ...result, move, score: 0, depth: 0 };
      const undo = applyMove(quickCtx, move, player);
      const winner = getMatchWinner(quickCtx);
      const score = winner !== null ? scoreForMatchWinner(winner, player, 1) : -evaluateWithMatch(quickCtx, opponent);
      revertMove(quickCtx, undo, player);
      // The previous PV's score/depth does not describe this replacement move.
      return { ...result, move, score, depth: winner === null ? 0 : 1 };
    };
    // If an external source (e.g. TSS) produced a move outside the root filter, do NOT return it.
    // This can happen under small budgets where we might otherwise return immediately.
    if (rootMoveFilter && !rootMoveFilter(result.move)) {
      const fallback = moves[0]?.move ?? null;
      return replacement(fallback);
    }

    const allowsImmediateLoss = (mv: Move): boolean => {
      const undo = applyMove(quickCtx, mv, player);
      const winner = getMatchWinner(quickCtx);

      let loses: boolean;
      if (winner === player) {
        // If we end the match immediately, do not second-guess it.
        loses = false;
      } else if (winner !== null) {
        // If our move ends the match for the opponent (e.g. rift gives them points), reject it.
        loses = true;
      } else {
        // Otherwise, only consider immediate *match-ending* threats on the opponent's reply.
        loses = sideHasImmediateMatchWinningMove(opponent, ply1MoveFilter);
      }

      revertMove(quickCtx, undo, player);
      return loses;
    };

    if (!allowsImmediateLoss(result.move)) return result;

    // Try alternatives (in movegen order) until we find one that doesn't lose immediately.
    for (const { move } of moves) {
      if (!move) continue;
      if (!allowsImmediateLoss(move)) {
        return replacement(move);
      }
    }

    return result;
  }

  const getRemainingMs = (): number => {
    if (timeLimit <= 0) return 0;
    return timeLimit - (Date.now() - startMs);
  };

  // Threat Space Search (tactical prover) only applies to the single-point game.
  // With score-clearing multi-point rules, TSS assumptions don't hold. TSS also
  // does not model callback-based opening constraints on future plies.
  if (scoreToWin === 1 && !rootMoveFilter && !ply1MoveFilter && !ply2MoveFilter) {
    const tssBudget =
      timeLimit > 0
        ? Math.max(1, Math.min(2500, Math.floor(Math.max(0, getRemainingMs()) * 0.3)))
        : 2500;

    const tssAttack = threatSpaceSearch(board, player, player, {
      timeLimitMs: Math.floor(tssBudget * 0.6),
      maxPlies: 10,
      maxAttackerMoves: 16,
      maxDefenderMoves: 24,
    });
    if (
      tssAttack.status === 'proven_win' &&
      tssAttack.move
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
    // Probe whether the opponent has a direct match-ending move on their next turn.
    const underCriticalThreat = hasCriticalThreat(board, opponent);
    const underImmediateThreat = underCriticalThreat || sideHasImmediateMatchWinningMove(opponent, ply1MoveFilter);
    let rootMoveHint: Move | null = options?.rootMoveHint ?? null;
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
        rootMoveHint = tssDefense.move;
        rootMoveHintNodes = tssDefense.nodes;

        // Keep the refutation as a fallback, but spend the remaining budget searching.
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
        preserveMoveOrdering: options?.preserveMoveOrdering ?? true,
        tt: options?.tt,
        preserveTTAge: options?.preserveTTAge,
        nnueWeights,
        scores,
        scoreToWin,
        rootMoveHint,
        rootMoveFilter: rootMoveFilter ?? undefined,
        ply1MoveFilter: ply1MoveFilter ?? undefined,
        ply2MoveFilter: ply2MoveFilter ?? undefined,
      });
      return sanitizeRootMove(result);
    }
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
    preserveMoveOrdering: options?.preserveMoveOrdering ?? true,
    tt: options?.tt,
    preserveTTAge: options?.preserveTTAge,
    nnueWeights,
    scores,
    scoreToWin,
    rootMoveHint: options?.rootMoveHint ?? null,
    rootMoveFilter: rootMoveFilter ?? undefined,
    ply1MoveFilter: ply1MoveFilter ?? undefined,
    ply2MoveFilter: ply2MoveFilter ?? undefined,
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

