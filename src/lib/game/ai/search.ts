/**
 * Search Algorithm - Iterative Deepening Alpha-Beta with PVS
 * The core search engine for the AI
 */

import { CONFIG } from './constants';
import type { Board, Color, Move, SearchResult } from './types';
import { getOpponent, moveToKey } from './utils';
import { makeMove, unmakeMove, getWinnerAfterMove } from './board';
import { evaluate, isQuietPosition } from './evaluate';
import { generateAllMoves, generateTacticalMoves } from './moveGen';
import { orderMoves, updateKillerMoves, updateHistory, clearMoveOrdering, PVTable, isInterestingMove, getLMRReduction, getFutilityMargin } from './moveOrder';
import { getTranspositionTable, TranspositionTable } from './transposition';
import { hasCriticalThreat } from './threats';
import { withTurn } from './zobrist';
import { threatSpaceSearch } from './tss';

// Search statistics
let nodesSearched = 0;
let searchStartTime = 0;
let searchTimeLimit = 0;
let searchAborted = false;

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
  board: Board,
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
  const standPat = evaluate(board, player);
  
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
  if (isQuietPosition(board, player)) {
    return standPat;
  }
  
  // Generate only tactical moves
  const tacticalMoves = generateTacticalMoves(board, player);
  
  for (const { move, score } of tacticalMoves) {
    // Delta pruning - skip moves that can't possibly improve alpha
    if (standPat + score + 50000 < localAlpha) {
      continue;
    }
    
    const undoInfo = makeMove(board, move, player);
    const evalScore = -quiescence(board, getOpponent(player), -beta, -localAlpha, depth - 1);
    unmakeMove(board, undoInfo, player);
    
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
  board: Board,
  player: Color,
  depth: number,
  alpha: number,
  beta: number,
  ply: number,
  tt: TranspositionTable,
  pvTable: PVTable,
  nullMoveAllowed: boolean = true
): SearchResult {
  nodesSearched++;
  
  // Time check
  if (isTimeUp()) {
    searchAborted = true;
    return { completed: false, score: 0, move: null };
  }
  
  // Transposition table probe
  const ttKey = withTurn(board.hash, player);
  const [ttHit, ttScore, ttBestMove] = tt.tryGetScore(ttKey, depth, alpha, beta);
  if (ttHit) {
    return { completed: true, score: ttScore, move: ttBestMove };
  }
  
  // Depth limit - enter quiescence
  if (depth <= 0) {
    const qScore = quiescence(board, player, alpha, beta, CONFIG.QUIESCENCE_DEPTH);
    return { completed: !searchAborted, score: qScore, move: null };
  }
  
  // Generate and order moves
  const underCriticalThreat = ply === 0 && hasCriticalThreat(board, getOpponent(player));
  let moves = orderMoves(board, player, ply, ttBestMove);

  // Progressive widening at root: start with a smaller set of top moves and expand with depth.
  if (ply === 0) {
    const base = underCriticalThreat ? 24 : 12;
    const perDepth = underCriticalThreat ? 6 : 4;
    const limit = Math.min(moves.length, base + perDepth * Math.max(0, depth - 1));
    moves = moves.slice(0, limit);
  }
  
  if (moves.length === 0) {
    // No legal moves (shouldn't happen in Gomoku)
    return { completed: true, score: evaluate(board, player), move: null };
  }
  
  let bestMove: Move | null = null;
  let bestScore = -CONFIG.INFINITY;
  let flag: 'exact' | 'lower' | 'upper' = 'upper';
  let searchedMoves = 0;
  
  for (const { move, score: moveScore } of moves) {
    const undoInfo = makeMove(board, move, player);
    
    let score: number;

    // Incremental terminal check based on the move we just made.
    // This replaces expensive full-board `hasWon` scans at every node.
    const winner = getWinnerAfterMove(board, move, player);
    if (winner !== null) {
      // Use child-ply (ply + 1) so earlier wins are preferred.
      score = winner === player ? (CONFIG.WIN_SCORE - (ply + 1)) : (CONFIG.LOSS_SCORE + (ply + 1));
      unmakeMove(board, undoInfo, player);
      searchedMoves++;
    } else {
      const isCapture = move.action === 'rift';
      const givesCheck = isInterestingMove(board, move, player, moveScore);
      // Threat extension: only at the frontier to avoid runaway depth in tactical lines.
      const extension = depth === 1 && givesCheck ? 1 : 0;
      const fullChildDepth = depth - 1 + extension;

      // Futility pruning (very conservative):
      // Skip late, non-tactical moves at shallow depth when even the optimistic moveScore
      // cannot raise alpha by the margin.
      if (!underCriticalThreat && depth <= 2 && searchedMoves >= 8 && !isCapture && !givesCheck) {
        const margin = getFutilityMargin(depth);
        if (moveScore + margin <= alpha) {
          unmakeMove(board, undoInfo, player);
          searchedMoves++;
          continue;
        }
      }
    
      // Principal Variation Search
      if (searchedMoves === 0) {
        // Full window search for first move (expected best move)
        const result = alphaBeta(
          board, getOpponent(player), fullChildDepth,
          -beta, -alpha, ply + 1, tt, pvTable, true
        );
        score = -result.score;
      } else {
        const reduction = underCriticalThreat ? 0 : getLMRReduction(searchedMoves, depth, isCapture, givesCheck);
        const reducedDepth = Math.max(0, fullChildDepth - reduction);

        // Null window search for other moves
        let result = alphaBeta(
          board, getOpponent(player), reducedDepth,
          -alpha - 1, -alpha, ply + 1, tt, pvTable, true
        );
        score = -result.score;

        // If we reduced depth and the move looks promising, re-search at full depth.
        if (reduction > 0 && score > alpha && !searchAborted) {
          result = alphaBeta(
            board, getOpponent(player), fullChildDepth,
            -alpha - 1, -alpha, ply + 1, tt, pvTable, true
          );
          score = -result.score;
        }
        
        // Re-search with full window if failed high
        if (score > alpha && score < beta && !searchAborted) {
          result = alphaBeta(
            board, getOpponent(player), fullChildDepth,
            -beta, -alpha, ply + 1, tt, pvTable, true
          );
          score = -result.score;
        }
      }
      
      unmakeMove(board, undoInfo, player);
      searchedMoves++;
    }
    
    if (searchAborted) {
      return { completed: false, score: 0, move: null };
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
          
          break;
        }
      }
    }
  }
  
  // Store in transposition table
  if (!searchAborted) {
    tt.store(ttKey, depth, bestScore, flag, bestMove);
  }
  
  return {
    completed: !searchAborted,
    score: bestScore,
    move: bestMove,
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
  }
): SearchResult {
  // Initialize search state
  searchStartTime = Date.now();
  searchTimeLimit = timeLimit;
  searchAborted = false;
  nodesSearched = 0;
  
  const tt = options?.tt ?? getTranspositionTable();
  if (!options?.preserveTTAge) {
    tt.newSearch();
  }
  
  const pvTable = options?.pvTable ?? new PVTable();
  if (!options?.preserveMoveOrdering) {
    clearMoveOrdering();
  }
  
  // CRITICAL: Always have a valid move before starting search
  // This guarantees we never return null
  const allMoves = generateAllMoves(board, player);
  let bestMoveSoFar: Move | null = allMoves.length > 0 ? allMoves[0].move : null;
  let bestScoreSoFar = allMoves.length > 0 ? allMoves[0].score : 0;
  let bestDepthSoFar = 0;
  
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
        board, player, depth,
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
    
    // Check if we have enough time for another iteration
    const elapsed = Date.now() - searchStartTime;
    const estimatedNextTime = elapsed * 3; // Rough estimate
    if (timeLimit > 0 && elapsed + estimatedNextTime > timeLimit * 0.9) {
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

  private bestMove: Move | null = null;
  private bestScore = 0;
  private bestDepth = 0;
  private lastScore = 0;
  private nextDepth = 1;

  constructor(board: Board, player: Color, maxDepth: number, tt: TranspositionTable) {
    this.board = board;
    this.player = player;
    this.maxDepth = maxDepth;
    this.tt = tt;
    this.pvTable = new PVTable();
    this.resetForPosition();
  }

  private resetForPosition(): void {
    // Age the TT once per new position so entries from old positions become replaceable.
    this.tt.newSearch();
    this.pvTable.clear();

    // Seed "best move so far" to guarantee non-null result.
    const moves = generateAllMoves(this.board, this.player);
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
          this.board, this.player, depth,
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

      const elapsed = Date.now() - searchStartTime;
      const estimatedNextTime = elapsed * 3;
      if (timeLimitMs > 0 && elapsed + estimatedNextTime > timeLimitMs * 0.9) {
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
  tt: TranspositionTable = getTranspositionTable()
): SearchSession {
  return new SearchSessionImpl(board, player, maxDepth, tt);
}

/**
 * Find the best move with full search
 * Guarantees a valid move is always returned
 */
export function findBestMove(
  board: Board,
  player: Color,
  timeLimit: number = CONFIG.DEFAULT_TIME,
  maxDepth: number = CONFIG.MAX_DEPTH
): SearchResult {
  // Quick check for obvious moves
  
  // 1. Check if we can win immediately
  const moves = generateAllMoves(board, player);
  
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
  
  for (const { move, score } of moves) {
    if (score >= CONFIG.WIN_SCORE - 1000) {
      return {
        completed: true,
        score,
        move,
        depth: 1,
        nodes: moves.length,
      };
    }
  }
  
  function opponentHasImmediateWinningMove(): boolean {
    const oppMoves = generateAllMoves(board, opponent);
    // Winning reinforce moves are scored at WIN_SCORE scale (or higher for single-win).
    return oppMoves.some(m => m.score >= CONFIG.WIN_SCORE - 1000);
  }

  // 2. Threat Space Search (tactical prover)
  // Spend a slice of the budget trying to PROVE a forced win or find a forced defense.
  const opponent = getOpponent(player);
  const tssBudget = Math.max(150, Math.min(2500, Math.floor(timeLimit * 0.4)));
  const tssAttack = threatSpaceSearch(board, player, player, {
    timeLimitMs: Math.floor(tssBudget * 0.6),
    maxPlies: 10,
    maxAttackerMoves: 16,
    maxDefenderMoves: 24,
  });
  if (tssAttack.status === 'proven_win' && tssAttack.move) {
    return {
      completed: true,
      score: CONFIG.WIN_SCORE,
      move: tssAttack.move,
      depth: 0,
      nodes: tssAttack.nodes,
    };
  }
  
  // If we are under tactical threat, try to find a refutation quickly.
  // IMPORTANT: In Gomoku Rift, two-stone reinforces can create one-move wins even without
  // classic single-stone win squares (e.g., open-three can be immediate win by placing both ends).
  // So we also probe whether the opponent has a direct winning move.
  if (hasCriticalThreat(board, opponent) || opponentHasImmediateWinningMove()) {
    const tssDefense = threatSpaceSearch(board, opponent, player, {
      timeLimitMs: Math.floor(tssBudget * 0.5),
      maxPlies: 10,
      maxAttackerMoves: 16,
      maxDefenderMoves: 32,
    });
    if (tssDefense.status === 'not_proven' && tssDefense.move) {
      // Defender found a refutation (within threat-space) - play it.
      return {
        completed: true,
        score: 0,
        move: tssDefense.move,
        depth: 0,
        nodes: tssDefense.nodes,
      };
    }
  }
  
  // 3. Check if opponent has critical threat we must respond to
  if (hasCriticalThreat(board, opponent)) {
    // Under critical threat - use FULL time and depth for defense
    // Don't reduce search when defending - we need the best defense!
    const result = iterativeDeepening(board, player, timeLimit, maxDepth, { preserveMoveOrdering: true });
    // iterativeDeepening guarantees a valid move
    return result;
  }
  
  // 4. Full search
  const result = iterativeDeepening(board, player, timeLimit, maxDepth, { preserveMoveOrdering: true });

  // Root sanity: if the chosen move allows an immediate opponent win, fall back to next-best root candidates.
  if (result.move) {
    const allowsImmediateLoss = (mv: Move): boolean => {
      const undo = makeMove(board, mv, player);
      const oppWins = generateAllMoves(board, opponent).some(m => m.score >= CONFIG.WIN_SCORE - 1000);
      unmakeMove(board, undo, player);
      return oppWins;
    };

    if (allowsImmediateLoss(result.move)) {
      const seen = new Set<string>();
      const candidates: Move[] = [];

      const push = (m: Move) => {
        const key = moveToKey(m);
        if (seen.has(key)) return;
        seen.add(key);
        candidates.push(m);
      };

      // Prefer the searched best move first, then top-scored alternatives.
      push(result.move);
      for (const m of moves.slice(0, 8)) {
        push(m.move);
      }

      for (const m of candidates) {
        if (!allowsImmediateLoss(m)) {
          if (m !== result.move) {
            return { ...result, move: m };
          }
          break;
        }
      }
    }
  }

  return result;
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

