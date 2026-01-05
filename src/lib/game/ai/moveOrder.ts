/**
 * Move Ordering for Alpha-Beta Pruning
 * Implements killer moves, history heuristic, and move sorting
 */

import { CONFIG } from './constants';
import type { Board, Color, Move, ScoredMove } from './types';
import { generateAllMoves } from './moveGen';
import type { MatchContext } from './moveGen';
import { decodeMove, encodeMove, MOVE_CODE_NONE } from './moveCodec';

/**
 * Killer Move Table
 * Stores moves that caused beta cutoffs at each depth
 */
class KillerMoveTable {
  private table: Int32Array;
  private maxDepth: number;
  
  constructor(maxDepth: number = CONFIG.MAX_DEPTH) {
    this.maxDepth = maxDepth;
    this.table = new Int32Array(maxDepth * CONFIG.KILLER_SLOTS);
    this.table.fill(MOVE_CODE_NONE);
  }
  
  /**
   * Add a killer move at the given depth
   */
  add(depth: number, moveCode: number): void {
    if (depth < 0 || depth >= this.maxDepth) return;
    if (moveCode === MOVE_CODE_NONE) return;

    const base = depth * CONFIG.KILLER_SLOTS;
    // Don't add if already the first killer
    if (this.table[base] === moveCode) return;

    // Shift existing killers and add new one at front
    for (let i = CONFIG.KILLER_SLOTS - 1; i > 0; i--) {
      this.table[base + i] = this.table[base + i - 1];
    }
    this.table[base] = moveCode;
  }
  
  /**
   * Check if a move is a killer at the given depth
   */
  isKiller(depth: number, moveCode: number): boolean {
    if (depth < 0 || depth >= this.maxDepth) return false;
    if (moveCode === MOVE_CODE_NONE) return false;

    const base = depth * CONFIG.KILLER_SLOTS;
    for (let i = 0; i < CONFIG.KILLER_SLOTS; i++) {
      if (this.table[base + i] === moveCode) return true;
    }
    return false;
  }
  
  /**
   * Get killer moves at the given depth
   */
  getKillers(depth: number): Move[] {
    if (depth < 0 || depth >= this.maxDepth) return [];

    const base = depth * CONFIG.KILLER_SLOTS;
    const out: Move[] = [];
    for (let i = 0; i < CONFIG.KILLER_SLOTS; i++) {
      const code = this.table[base + i];
      if (code === MOVE_CODE_NONE) continue;
      const mv = decodeMove(code);
      if (mv) out.push(mv);
    }
    return out;
  }
  
  /**
   * Clear all killer moves
   */
  clear(): void {
    this.table.fill(MOVE_CODE_NONE);
  }
}

const HISTORY_TABLE_SIZE = 1 << 18; // >= max encodeMove() value

/**
 * History Heuristic Table
 * Tracks how often moves cause cutoffs
 */
class HistoryTable {
  private table: Int32Array;
  
  constructor() {
    this.table = new Int32Array(HISTORY_TABLE_SIZE);
  }
  
  /**
   * Update history score for a move
   */
  update(moveCode: number, depth: number): void {
    if (moveCode === MOVE_CODE_NONE) return;
    if (moveCode < 0 || moveCode >= this.table.length) return;
    const bonus = depth * depth; // Deeper cutoffs are more valuable
    const current = this.table[moveCode];
    const next = current + bonus;
    // Saturate to avoid overflow; aging is handled by periodic clears between searches.
    this.table[moveCode] = next > 0x7fffffff ? 0x7fffffff : next;
  }
  
  /**
   * Get history score for a move
   */
  get(moveCode: number): number {
    if (moveCode === MOVE_CODE_NONE) return 0;
    if (moveCode < 0 || moveCode >= this.table.length) return 0;
    return this.table[moveCode];
  }
  
  /**
   * Scale all values (for aging)
   */
  /**
   * Clear all history
   */
  clear(): void {
    this.table.fill(0);
  }
}

/**
 * Countermove table
 *
 * Stores the best known refutation move for a given parent move (by encoded moveCode).
 * This is a strong, cheap ordering hint at the child node.
 */
class CounterMoveTable {
  private table: Int32Array;

  constructor() {
    this.table = new Int32Array(HISTORY_TABLE_SIZE);
    this.table.fill(MOVE_CODE_NONE);
  }

  set(prevMoveCode: number, replyMoveCode: number): void {
    if (prevMoveCode === MOVE_CODE_NONE) return;
    if (replyMoveCode === MOVE_CODE_NONE) return;
    if (prevMoveCode < 0 || prevMoveCode >= this.table.length) return;
    this.table[prevMoveCode] = replyMoveCode;
  }

  get(prevMoveCode: number): number {
    if (prevMoveCode === MOVE_CODE_NONE) return MOVE_CODE_NONE;
    if (prevMoveCode < 0 || prevMoveCode >= this.table.length) return MOVE_CODE_NONE;
    return this.table[prevMoveCode];
  }

  clear(): void {
    this.table.fill(MOVE_CODE_NONE);
  }
}

/**
 * Continuation history (hashed)
 *
 * Tracks successful move pairs: (previous move -> current move).
 * This is a lightweight approximation of Stockfish-style continuation history.
 */
const CONT_HIST_SIZE = 1 << 20; // 1,048,576 entries (~4MB int32) - OK for browser worker.

class ContinuationHistoryTable {
  private table: Int32Array;

  constructor() {
    this.table = new Int32Array(CONT_HIST_SIZE);
  }

  private index(prevMoveCode: number, moveCode: number): number {
    // Mix two 18-bit-ish codes into a 32-bit hash. Keep it cheap and deterministic.
    const key = (((prevMoveCode * 1315423911) ^ moveCode) >>> 0) & (CONT_HIST_SIZE - 1);
    return key;
  }

  update(prevMoveCode: number, moveCode: number, depth: number): void {
    if (prevMoveCode === MOVE_CODE_NONE) return;
    if (moveCode === MOVE_CODE_NONE) return;
    const bonus = depth * depth;
    const idx = this.index(prevMoveCode, moveCode);
    const current = this.table[idx];
    const next = current + bonus;
    this.table[idx] = next > 0x7fffffff ? 0x7fffffff : next;
  }

  get(prevMoveCode: number, moveCode: number): number {
    if (prevMoveCode === MOVE_CODE_NONE) return 0;
    if (moveCode === MOVE_CODE_NONE) return 0;
    return this.table[this.index(prevMoveCode, moveCode)];
  }

  clear(): void {
    this.table.fill(0);
  }
}

// Global instances
const killerTable = new KillerMoveTable();
const historyTable = new HistoryTable();
const counterTable = new CounterMoveTable();
const continuationTable = new ContinuationHistoryTable();

/**
 * Update killer moves after a beta cutoff
 */
export function updateKillerMoves(depth: number, move: Move): void {
  killerTable.add(depth, encodeMove(move));
}

/**
 * Update history heuristic after a cutoff
 */
export function updateHistory(move: Move, depth: number): void {
  historyTable.update(encodeMove(move), depth);
}

export function updateCounterMove(prevMove: Move | null, reply: Move): void {
  if (!prevMove) return;
  counterTable.set(encodeMove(prevMove), encodeMove(reply));
}

export function updateContinuationHistory(prevMove: Move | null, move: Move, depth: number): void {
  if (!prevMove) return;
  continuationTable.update(encodeMove(prevMove), encodeMove(move), depth);
}

/**
 * Clear all move ordering tables
 */
export function clearMoveOrdering(): void {
  killerTable.clear();
  historyTable.clear();
  counterTable.clear();
  continuationTable.clear();
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
  ttBestMove: Move | null,
  prevMove: Move | null = null,
  match?: MatchContext
): ScoredMove[] {
  // Generate all candidate moves with their base scores
  const moves = generateAllMoves(board, player, match);

  const ttCode = ttBestMove ? encodeMove(ttBestMove) : MOVE_CODE_NONE;
  const prevCode = prevMove ? encodeMove(prevMove) : MOVE_CODE_NONE;
  const counterCode = prevCode !== MOVE_CODE_NONE ? counterTable.get(prevCode) : MOVE_CODE_NONE;
  
  for (const m of moves) {
    const move = m.move;
    const score = m.score;
    const code = encodeMove(move);
    let orderScore = score;
    
    // TT best move gets highest priority
    if (ttCode !== MOVE_CODE_NONE && code === ttCode) {
      orderScore += 100000000;
    }
    
    // Winning moves (very high score in evaluation)
    if (score >= CONFIG.WIN_SCORE - 1000) {
      orderScore += 50000000;
    }
    
    // Killer moves
    if (killerTable.isKiller(depth, code)) {
      orderScore += 1000000;
    }

    // Countermove heuristic (best known reply to the parent move)
    if (counterCode !== MOVE_CODE_NONE && code === counterCode) {
      orderScore += 1200000;
    }
    
    // History heuristic
    orderScore += historyTable.get(code);

    // Continuation history (prevMove -> move)
    orderScore += continuationTable.get(prevCode, code);
    
    m.orderScore = orderScore;
  }
  
  // Sort by order score (fall back to base score if absent).
  moves.sort((a, b) => (b.orderScore! - a.orderScore!));
  return moves;
}

/**
 * Get the best move from TT or killer table for move ordering
 */
export function getPriorityMoves(
  depth: number,
  ttBestMove: Move | null
): Move[] {
  const out: Move[] = [];
  const seen = new Set<number>();

  const ttCode = ttBestMove ? encodeMove(ttBestMove) : MOVE_CODE_NONE;
  if (ttCode !== MOVE_CODE_NONE) {
    seen.add(ttCode);
    const mv = decodeMove(ttCode);
    if (mv) out.push(mv);
  }

  const killers = killerTable.getKillers(depth);
  for (const k of killers) {
    const code = encodeMove(k);
    if (code === MOVE_CODE_NONE) continue;
    if (seen.has(code)) continue;
    seen.add(code);
    out.push(k);
  }

  return out;
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

