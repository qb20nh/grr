/**
 * Transposition Table for caching search results
 * Uses Zobrist hashing for position identification
 */

import { CONFIG } from './constants';
import type { TTEntry, TTFlag, Move } from './types';
import { decodeMove, encodeMove, MOVE_CODE_NONE } from './moveCodec';

/**
 * Transposition Table implementation
 * Uses typed arrays for speed and to avoid GC pressure.
 */
export class TranspositionTable {
  private keys: BigUint64Array;
  private scores: Int32Array;
  private depths: Uint16Array;
  private ages: Uint16Array;
  private flags: Uint8Array;
  private moves: Int32Array;
  private size: number;
  private mask: number;
  private currentAge: number;
  private hits: number;
  private misses: number;
  private collisions: number;
  private hitsCurrentAge: number;
  private hitsPrevAge: number;
  private hitsOtherAge: number;
  
  constructor(size: number = CONFIG.TT_SIZE) {
    if (size <= 0 || (size & (size - 1)) !== 0) {
      throw new Error(`TT size must be a positive power of two, got ${size}`);
    }
    this.size = size;
    this.mask = size - 1; // Assumes size is power of 2
    this.keys = new BigUint64Array(size);
    this.scores = new Int32Array(size);
    this.depths = new Uint16Array(size);
    this.ages = new Uint16Array(size);
    this.flags = new Uint8Array(size);
    this.moves = new Int32Array(size);
    this.moves.fill(MOVE_CODE_NONE);
    this.currentAge = 0;
    this.hits = 0;
    this.misses = 0;
    this.collisions = 0;
    this.hitsCurrentAge = 0;
    this.hitsPrevAge = 0;
    this.hitsOtherAge = 0;
  }

  private countHit(storedAge: number): void {
    this.hits++;
    const prevAge = (this.currentAge - 1) & 0xffff;
    if (storedAge === this.currentAge) {
      this.hitsCurrentAge++;
    } else if (storedAge === prevAge) {
      this.hitsPrevAge++;
    } else {
      this.hitsOtherAge++;
    }
  }
  
  /**
   * Get index in table from hash
   */
  private getIndex(hash: bigint): number {
    // Use lower bits of hash for index
    return Number(hash & BigInt(this.mask));
  }
  
  /**
   * Probe the transposition table for an entry
   */
  probe(hash: bigint): TTEntry | null {
    const index = this.getIndex(hash);
    const storedDepth = this.depths[index];
    
    if (storedDepth === 0) {
      this.misses++;
      return null;
    }
    
    // Verify hash matches (collision detection)
    const storedHash = this.keys[index];
    if (storedHash !== hash) {
      this.collisions++;
      this.misses++;
      return null;
    }
    
    this.countHit(this.ages[index]);
    return {
      hash,
      depth: storedDepth,
      score: this.scores[index],
      flag: codeToFlag(this.flags[index]),
      bestMove: decodeMove(this.moves[index]),
      age: this.ages[index],
    };
  }
  
  /**
   * Store a result in the transposition table
   */
  store(
    hash: bigint,
    depth: number,
    score: number,
    flag: TTFlag,
    bestMove: Move | null,
    ply: number
  ): void {
    const index = this.getIndex(hash);
    const existingDepth = this.depths[index];
    const existingHash = this.keys[index];
    const existingAge = this.ages[index];
    
    // Replacement policy: always replace if:
    // 1. Slot is empty
    // 2. New entry has greater depth
    // 3. Existing entry is from older search
    // 4. Existing entry has same hash (update)
    
    // Replacement policy:
    // - Always replace empty slots or same-hash updates.
    // - Prefer deeper results.
    // - Allow replacing older entries, but avoid wiping deep old entries with shallow new ones.
    const isOlder = existingAge !== this.currentAge;
    const oldButComparableDepth = depth + 2 >= existingDepth;

    if (
      existingDepth === 0 ||
      existingHash === hash ||
      depth >= existingDepth ||
      (isOlder && oldButComparableDepth)
    ) {
      this.keys[index] = hash;
      this.depths[index] = depth;
      // Store score in a ply-neutral form for mate-distance values so TT remains valid
      // across transpositions reached at different plies.
      this.scores[index] = toTTScore(score, ply);
      this.flags[index] = flagToCode(flag);
      this.moves[index] = encodeMove(bestMove);
      this.ages[index] = this.currentAge;
    }
  }
  
  /**
   * Get the best move from TT if available
   */
  getBestMove(hash: bigint): Move | null {
    const entry = this.probe(hash);
    return entry?.bestMove ?? null;
  }
  
  /**
   * Try to get a usable score from TT
   * Returns [usable, score] where usable indicates if score can be used directly
   */
  tryGetScore(
    hash: bigint,
    depth: number,
    alpha: number,
    beta: number,
    ply: number
  ): [boolean, number, Move | null] {
    const index = this.getIndex(hash);
    const storedDepth = this.depths[index];
    
    if (storedDepth === 0) {
      this.misses++;
      return [false, 0, null];
    }

    const storedHash = this.keys[index];
    if (storedHash !== hash) {
      this.collisions++;
      this.misses++;
      return [false, 0, null];
    }

    this.countHit(this.ages[index]);

    const bestMove = decodeMove(this.moves[index]);

    if (storedDepth < depth) {
      return [false, 0, bestMove];
    }
    
    // Convert stored TT score into the current node's score domain.
    // This matters for mate-distance (WIN_SCORE/LOSS_SCORE +/- ply) where ply is not
    // part of the TT key.
    const score = fromTTScore(this.scores[index], ply);
    const flag = codeToFlag(this.flags[index]);
    
    if (flag === 'exact') {
      return [true, score, bestMove];
    }
    
    if (flag === 'lower' && score >= beta) {
      return [true, score, bestMove];
    }
    
    if (flag === 'upper' && score <= alpha) {
      return [true, score, bestMove];
    }
    
    // Can't use score directly, but might have best move
    return [false, 0, bestMove];
  }
  
  /**
   * Increment age for new search
   */
  newSearch(): void {
    // uint16 wrap is fine; age is only compared relative to currentAge.
    this.currentAge = (this.currentAge + 1) & 0xffff;
  }

  getCurrentAge(): number {
    return this.currentAge;
  }
  
  /**
   * Clear the entire table
   */
  clear(): void {
    this.keys.fill(0n);
    this.scores.fill(0);
    this.depths.fill(0);
    this.ages.fill(0);
    this.flags.fill(0);
    this.moves.fill(MOVE_CODE_NONE);
    this.currentAge = 0;
    this.hits = 0;
    this.misses = 0;
    this.collisions = 0;
  }
  
  /**
   * Get table statistics
   */
  getStats(): { hits: number; misses: number; collisions: number; fillRate: number } {
    let filled = 0;
    for (let i = 0; i < this.size; i++) {
      if (this.depths[i] !== 0) filled++;
    }
    
    return {
      hits: this.hits,
      misses: this.misses,
      collisions: this.collisions,
      fillRate: filled / this.size,
    };
  }
  
  /**
   * Reset statistics counters
   */
  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
    this.collisions = 0;
    this.hitsCurrentAge = 0;
    this.hitsPrevAge = 0;
    this.hitsOtherAge = 0;
  }

  getProbeStats(): {
    currentAge: number;
    hits: number;
    misses: number;
    collisions: number;
    hitsCurrentAge: number;
    hitsPrevAge: number;
    hitsOtherAge: number;
  } {
    return {
      currentAge: this.currentAge,
      hits: this.hits,
      misses: this.misses,
      collisions: this.collisions,
      hitsCurrentAge: this.hitsCurrentAge,
      hitsPrevAge: this.hitsPrevAge,
      hitsOtherAge: this.hitsOtherAge,
    };
  }
}

// ---- Mate-distance score normalization ----
// Search encodes faster wins/losses by shifting WIN_SCORE/LOSS_SCORE by (ply+1).
// Ply is NOT part of the TT key, so we must store such scores in a ply-neutral form.
const MATE_SCORE_MARGIN = 10000;

function isWinScore(score: number): boolean {
  return score >= CONFIG.WIN_SCORE - MATE_SCORE_MARGIN;
}

function isLossScore(score: number): boolean {
  return score <= CONFIG.LOSS_SCORE + MATE_SCORE_MARGIN;
}

function toTTScore(nodeScore: number, ply: number): number {
  if (isWinScore(nodeScore)) return nodeScore + ply;
  if (isLossScore(nodeScore)) return nodeScore - ply;
  return nodeScore;
}

function fromTTScore(storedScore: number, ply: number): number {
  if (isWinScore(storedScore)) return storedScore - ply;
  if (isLossScore(storedScore)) return storedScore + ply;
  return storedScore;
}

function flagToCode(flag: TTFlag): number {
  switch (flag) {
    case 'exact':
      return 0;
    case 'lower':
      return 1;
    case 'upper':
      return 2;
  }
}

function codeToFlag(code: number): TTFlag {
  switch (code) {
    case 0:
      return 'exact';
    case 1:
      return 'lower';
    case 2:
      return 'upper';
    default:
      return 'exact';
  }
}

// Global transposition table instance
let globalTT: TranspositionTable | null = null;

/**
 * Get or create the global transposition table
 */
export function getTranspositionTable(): TranspositionTable {
  if (globalTT === null) {
    globalTT = new TranspositionTable();
  }
  return globalTT;
}

/**
 * Clear the global transposition table
 */
export function clearTranspositionTable(): void {
  if (globalTT !== null) {
    globalTT.clear();
  }
}

