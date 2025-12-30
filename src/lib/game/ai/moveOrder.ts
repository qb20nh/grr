/**
 * Move Ordering for Alpha-Beta Pruning
 * Implements killer moves, history heuristic, and move sorting
 */

import { CONFIG } from './constants';
import type { Board, Color, Move, ScoredMove, ReinforceMove } from './types';
import { movesEqual, moveToKey } from './utils';
import { generateAllMoves } from './moveGen';

/**
 * Killer Move Table
 * Stores moves that caused beta cutoffs at each depth
 */
class KillerMoveTable {
  private table: (Move | null)[][];
  
  constructor(maxDepth: number = CONFIG.MAX_DEPTH) {
    this.table = Array(maxDepth).fill(null).map(() => 
      Array(CONFIG.KILLER_SLOTS).fill(null)
    );
  }
  
  /**
   * Add a killer move at the given depth
   */
  add(depth: number, move: Move): void {
    if (depth < 0 || depth >= this.table.length) return;
    
    const slot = this.table[depth];
    
    // Don't add if already the first killer
    if (movesEqual(slot[0], move)) return;
    
    // Shift existing killers and add new one at front
    for (let i = CONFIG.KILLER_SLOTS - 1; i > 0; i--) {
      slot[i] = slot[i - 1];
    }
    slot[0] = move;
  }
  
  /**
   * Check if a move is a killer at the given depth
   */
  isKiller(depth: number, move: Move): boolean {
    if (depth < 0 || depth >= this.table.length) return false;
    
    return this.table[depth].some(k => movesEqual(k, move));
  }
  
  /**
   * Get killer moves at the given depth
   */
  getKillers(depth: number): Move[] {
    if (depth < 0 || depth >= this.table.length) return [];
    
    return this.table[depth].filter((m): m is Move => m !== null);
  }
  
  /**
   * Clear all killer moves
   */
  clear(): void {
    for (const slot of this.table) {
      slot.fill(null);
    }
  }
}

/**
 * History Heuristic Table
 * Tracks how often moves cause cutoffs
 */
class HistoryTable {
  private table: Map<string, number>;
  private maxValue: number;
  
  constructor() {
    this.table = new Map();
    this.maxValue = 0;
  }
  
  /**
   * Update history score for a move
   */
  update(move: Move, depth: number): void {
    const key = moveToKey(move);
    const bonus = depth * depth; // Deeper cutoffs are more valuable
    const current = this.table.get(key) ?? 0;
    const newValue = current + bonus;
    
    this.table.set(key, newValue);
    this.maxValue = Math.max(this.maxValue, newValue);
    
    // Periodically scale down to prevent overflow
    if (this.maxValue > 1000000) {
      this.scale(0.5);
    }
  }
  
  /**
   * Get history score for a move
   */
  get(move: Move): number {
    return this.table.get(moveToKey(move)) ?? 0;
  }
  
  /**
   * Scale all values (for aging)
   */
  scale(factor: number): void {
    for (const [key, value] of this.table) {
      this.table.set(key, Math.floor(value * factor));
    }
    this.maxValue = Math.floor(this.maxValue * factor);
  }
  
  /**
   * Clear all history
   */
  clear(): void {
    this.table.clear();
    this.maxValue = 0;
  }
}

// Global instances
const killerTable = new KillerMoveTable();
const historyTable = new HistoryTable();

/**
 * Update killer moves after a beta cutoff
 */
export function updateKillerMoves(depth: number, move: Move): void {
  killerTable.add(depth, move);
}

/**
 * Update history heuristic after a cutoff
 */
export function updateHistory(move: Move, depth: number): void {
  historyTable.update(move, depth);
}

/**
 * Clear all move ordering tables
 */
export function clearMoveOrdering(): void {
  killerTable.clear();
  historyTable.clear();
}

/**
 * Order moves for optimal alpha-beta pruning
 * 
 * Priority order:
 * 1. TT best move (passed in)
 * 2. Winning moves
 * 3. Killer moves
 * 4. High history score
 * 5. Regular scored moves
 */
export function orderMoves(
  board: Board,
  player: Color,
  depth: number,
  ttBestMove: Move | null
): ScoredMove[] {
  // Generate all candidate moves with their base scores
  const moves = generateAllMoves(board, player);
  
  // Calculate ordering score for each move
  const orderedMoves: { move: Move; score: number; orderScore: number }[] = [];
  
  for (const { move, score } of moves) {
    let orderScore = score;
    
    // TT best move gets highest priority
    if (ttBestMove && movesEqual(move, ttBestMove)) {
      orderScore += 100000000;
    }
    
    // Winning moves (very high score in evaluation)
    if (score >= CONFIG.WIN_SCORE - 1000) {
      orderScore += 50000000;
    }
    
    // Killer moves
    if (killerTable.isKiller(depth, move)) {
      orderScore += 1000000;
    }
    
    // History heuristic
    orderScore += historyTable.get(move);
    
    orderedMoves.push({ move, score, orderScore });
  }
  
  // Sort by order score
  orderedMoves.sort((a, b) => b.orderScore - a.orderScore);
  
  // Return as ScoredMove array (using original score, not orderScore)
  return orderedMoves.map(m => ({ move: m.move, score: m.score }));
}

/**
 * Get the best move from TT or killer table for move ordering
 */
export function getPriorityMoves(
  depth: number,
  ttBestMove: Move | null
): Move[] {
  const moves: Move[] = [];
  
  if (ttBestMove) {
    moves.push(ttBestMove);
  }
  
  const killers = killerTable.getKillers(depth);
  for (const k of killers) {
    if (!moves.some(m => movesEqual(m, k))) {
      moves.push(k);
    }
  }
  
  return moves;
}

/**
 * Late Move Reduction (LMR) threshold
 * Returns how much to reduce search depth for late moves
 */
export function getLMRReduction(
  moveIndex: number,
  depth: number,
  isCapture: boolean,
  givesCheck: boolean
): number {
  // Don't reduce first few moves
  if (moveIndex < 3) return 0;
  
  // Don't reduce captures or checks much
  if (isCapture) return 0;
  if (givesCheck) return 0;
  
  // Reduce more for later moves and higher depths
  if (depth >= 6 && moveIndex >= 10) return 2;
  if (depth >= 4 && moveIndex >= 6) return 1;
  
  return 0;
}

/**
 * Futility pruning margin
 * Returns the margin for futility pruning at given depth
 */
export function getFutilityMargin(depth: number): number {
  // Margins increase with depth
  const margins = [0, 100, 300, 500, 700, 900];
  return margins[Math.min(depth, margins.length - 1)];
}

/**
 * Check if a move should be considered "interesting" for extensions
 */
export function isInterestingMove(
  board: Board,
  move: Move,
  player: Color,
  score: number
): boolean {
  // Winning moves are interesting
  if (score >= CONFIG.WIN_SCORE - 10000) return true;
  
  // Moves with very high scores are interesting
  if (score >= 100000) return true;
  
  // Rift moves that break threats are interesting
  if (move.action === 'rift' && score >= 50000) return true;
  
  return false;
}

/**
 * Principal Variation tracking
 */
export class PVTable {
  private pv: Move[][];
  private pvLength: number[];
  
  constructor(maxDepth: number = CONFIG.MAX_DEPTH) {
    this.pv = Array(maxDepth).fill(null).map(() => []);
    this.pvLength = Array(maxDepth).fill(0);
  }
  
  /**
   * Update PV when we find a new best move
   */
  update(ply: number, move: Move): void {
    // Set this move as the first in this ply's PV
    this.pv[ply] = [move];
    this.pvLength[ply] = 1;
    
    // Copy child's PV
    if (ply + 1 < this.pv.length && this.pvLength[ply + 1] > 0) {
      for (let i = 0; i < this.pvLength[ply + 1]; i++) {
        this.pv[ply].push(this.pv[ply + 1][i]);
      }
      this.pvLength[ply] += this.pvLength[ply + 1];
    }
  }
  
  /**
   * Get the principal variation
   */
  getPV(ply: number = 0): Move[] {
    return this.pv[ply].slice(0, this.pvLength[ply]);
  }
  
  /**
   * Clear PV
   */
  clear(): void {
    for (let i = 0; i < this.pv.length; i++) {
      this.pv[i] = [];
      this.pvLength[i] = 0;
    }
  }
}

