/**
 * Transposition Table for caching search results
 * Uses Zobrist hashing for position identification
 */

import { CONFIG } from './constants';
import type { TTEntry, TTFlag, Move } from './types';
import { decodeMove, encodeMove, MOVE_CODE_NONE } from './moveCodec';

export interface SharedTranspositionTableBacking {
  readonly size: number;
  readonly buffer: SharedArrayBuffer;
}

interface SharedTTLayout {
  totalBytes: number;
  keysOffset: number;
  scoresOffset: number;
  depthsOffset: number;
  agesOffset: number;
  flagsOffset: number;
  movesOffset: number;
}

function alignOffset(offset: number, alignment: number): number {
  // alignment must be a power of two
  return (offset + (alignment - 1)) & ~(alignment - 1);
}

function computeSharedTTLayout(size: number): SharedTTLayout {
  let offset = 0;

  offset = alignOffset(offset, 8);
  const keysOffset = offset;
  offset += size * 8;

  offset = alignOffset(offset, 4);
  const scoresOffset = offset;
  offset += size * 4;

  offset = alignOffset(offset, 2);
  const depthsOffset = offset;
  offset += size * 2;

  offset = alignOffset(offset, 2);
  const agesOffset = offset;
  offset += size * 2;

  offset = alignOffset(offset, 1);
  const flagsOffset = offset;
  offset += size * 1;

  offset = alignOffset(offset, 4);
  const movesOffset = offset;
  offset += size * 4;

  return {
    totalBytes: offset,
    keysOffset,
    scoresOffset,
    depthsOffset,
    agesOffset,
    flagsOffset,
    movesOffset,
  };
}

export function createSharedTranspositionTableBacking(size: number = CONFIG.TT_SIZE): SharedTranspositionTableBacking {
  if (size <= 0 || (size & (size - 1)) !== 0) {
    throw new Error(`TT size must be a positive power of two, got ${size}`);
  }
  if (size < 2) {
    throw new Error(`TT size must be >= 2 for 2-way buckets, got ${size}`);
  }

  const layout = computeSharedTTLayout(size);
  const buffer = new SharedArrayBuffer(layout.totalBytes);
  // SharedArrayBuffer initializes to 0; we must set move codes to MOVE_CODE_NONE explicitly.
  new Int32Array(buffer, layout.movesOffset, size).fill(MOVE_CODE_NONE);
  return { size, buffer };
}

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
  private assoc: number;
  private sets: number;
  private setMask: number;
  private currentAge: number;
  private isShared: boolean;
  private hits: number;
  private misses: number;
  private collisions: number;
  private hitsCurrentAge: number;
  private hitsPrevAge: number;
  private hitsOtherAge: number;
  
  constructor(sizeOrBacking: number | SharedTranspositionTableBacking = CONFIG.TT_SIZE) {
    const size = typeof sizeOrBacking === 'number' ? sizeOrBacking : sizeOrBacking.size;
    if (size <= 0 || (size & (size - 1)) !== 0) {
      throw new Error(`TT size must be a positive power of two, got ${size}`);
    }
    if (size < 2) {
      throw new Error(`TT size must be >= 2 for 2-way buckets, got ${size}`);
    }
    this.size = size;
    // 2-way set-associative TT (same total entry count as before).
    this.assoc = 2;
    this.sets = size / this.assoc;
    this.setMask = this.sets - 1; // sets is a power of two (size is a power of two, assoc=2)

    if (typeof sizeOrBacking === 'number') {
      this.isShared = false;
      this.keys = new BigUint64Array(size);
      this.scores = new Int32Array(size);
      this.depths = new Uint16Array(size);
      this.ages = new Uint16Array(size);
      this.flags = new Uint8Array(size);
      this.moves = new Int32Array(size);
      this.moves.fill(MOVE_CODE_NONE);
    } else {
      this.isShared = true;
      const layout = computeSharedTTLayout(size);
      const buffer = sizeOrBacking.buffer;
      this.keys = new BigUint64Array(buffer, layout.keysOffset, size);
      this.scores = new Int32Array(buffer, layout.scoresOffset, size);
      this.depths = new Uint16Array(buffer, layout.depthsOffset, size);
      this.ages = new Uint16Array(buffer, layout.agesOffset, size);
      this.flags = new Uint8Array(buffer, layout.flagsOffset, size);
      this.moves = new Int32Array(buffer, layout.movesOffset, size);
    }

    this.currentAge = 0;
    this.hits = 0;
    this.misses = 0;
    this.collisions = 0;
    this.hitsCurrentAge = 0;
    this.hitsPrevAge = 0;
    this.hitsOtherAge = 0;
  }

  private normalizeKey(hash: bigint): bigint {
    // Reserve 0 as an "empty / being-written" sentinel for shared-TT safety.
    // Zobrist hashes are effectively uniform; hash==0 is astronomically unlikely but still possible.
    return hash === 0n ? 1n : hash;
  }

  private loadKey(idx: number): bigint {
    if (!this.isShared) return this.keys[idx];
    // TS libdefs don't reliably include BigUint64Array overloads in all configs; cast for compatibility.
    return Atomics.load(this.keys as unknown as any, idx) as bigint;
  }

  private storeKey(idx: number, key: bigint): void {
    if (!this.isShared) {
      this.keys[idx] = key;
      return;
    }
    Atomics.store(this.keys as unknown as any, idx, key);
  }

  private loadScore(idx: number): number {
    // NOTE: In shared-TT mode we intentionally avoid Atomics on the hot-path payload fields
    // (score/depth/age/flag/move) to reduce overhead. We rely on an atomic key commit
    // (store key last, load key first/last) to avoid using torn entries.
    return this.scores[idx];
  }

  private storeScore(idx: number, score: number): void {
    this.scores[idx] = score;
  }

  private loadDepth(idx: number): number {
    return this.depths[idx];
  }

  private storeDepth(idx: number, depth: number): void {
    this.depths[idx] = depth;
  }

  private loadAge(idx: number): number {
    return this.ages[idx];
  }

  private storeAge(idx: number, age: number): void {
    this.ages[idx] = age;
  }

  private loadFlagCode(idx: number): number {
    return this.flags[idx];
  }

  private storeFlagCode(idx: number, flagCode: number): void {
    this.flags[idx] = flagCode;
  }

  private loadMoveCode(idx: number): number {
    return this.moves[idx];
  }

  private storeMoveCode(idx: number, moveCode: number): void {
    this.moves[idx] = moveCode;
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
   * Get the base index (first slot) for a 2-way bucket from hash
   */
  private getBaseIndex(hash: bigint): number {
    // Use lower bits of hash for set index, then scale by associativity.
    // Shift is safe: set index fits in 32-bit range here.
    return Number(hash & BigInt(this.setMask)) << 1;
  }
  
  /**
   * Probe the transposition table for an entry
   */
  probe(hash: bigint): TTEntry | null {
    const key = this.normalizeKey(hash);
    const base = this.getBaseIndex(hash);
    const idx0 = base;
    const idx1 = base + 1;

    const d0 = this.loadDepth(idx0);
    const d1 = this.loadDepth(idx1);

    let idx = -1;
    if (d0 !== 0 && this.loadKey(idx0) === key) idx = idx0;
    else if (d1 !== 0 && this.loadKey(idx1) === key) idx = idx1;

    if (idx === -1) {
      this.misses++;
      if (d0 !== 0 || d1 !== 0) this.collisions++;
      return null;
    }

    // Load fields, then re-check key to avoid torn reads (shared TT).
    const storedAge = this.loadAge(idx);
    const storedDepth = this.loadDepth(idx);
    const storedScore = this.loadScore(idx);
    const storedFlagCode = this.loadFlagCode(idx);
    const storedMoveCode = this.loadMoveCode(idx);
    const k2 = this.loadKey(idx);
    if (k2 !== key || storedDepth === 0) {
      return null;
    }

    this.countHit(storedAge);
    return {
      hash,
      depth: storedDepth,
      score: storedScore,
      flag: codeToFlag(storedFlagCode),
      bestMove: decodeMove(storedMoveCode),
      age: storedAge,
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
    const key = this.normalizeKey(hash);
    const base = this.getBaseIndex(hash);
    const idx0 = base;
    const idx1 = base + 1;

    const d0 = this.loadDepth(idx0);
    const d1 = this.loadDepth(idx1);
    const h0 = this.loadKey(idx0);
    const h1 = this.loadKey(idx1);

    // Prefer updating an existing matching entry.
    let idx = -1;
    if (d0 !== 0 && h0 === key) idx = idx0;
    else if (d1 !== 0 && h1 === key) idx = idx1;
    else if (d0 === 0) idx = idx0;
    else if (d1 === 0) idx = idx1;

    if (idx === -1) {
      // Choose a replacement slot using a conservative depth/age policy.
      const age0 = this.loadAge(idx0);
      const age1 = this.loadAge(idx1);
      const isOlder0 = age0 !== this.currentAge;
      const isOlder1 = age1 !== this.currentAge;

      const replaceable0 = depth >= d0 || (isOlder0 && depth + 2 >= d0);
      const replaceable1 = depth >= d1 || (isOlder1 && depth + 2 >= d1);

      if (!replaceable0 && !replaceable1) {
        return; // keep both entries
      }

      if (replaceable0 && !replaceable1) idx = idx0;
      else if (!replaceable0 && replaceable1) idx = idx1;
      else {
        // Both replaceable: prefer older, then shallower.
        if (isOlder0 !== isOlder1) idx = isOlder0 ? idx0 : idx1;
        else idx = d0 <= d1 ? idx0 : idx1;
      }
    }

    // Shared-TT safety: clear key first so other threads won't match this slot mid-write.
    if (this.isShared) {
      this.storeKey(idx, 0n);
    }

    this.storeDepth(idx, depth);
    // Store score in a ply-neutral form for mate-distance values so TT remains valid
    // across transpositions reached at different plies.
    this.storeScore(idx, toTTScore(score, ply));
    this.storeFlagCode(idx, flagToCode(flag));
    this.storeMoveCode(idx, encodeMove(bestMove));
    this.storeAge(idx, this.currentAge);
    // Commit key last (makes entry visible).
    this.storeKey(idx, key);
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
    const key = this.normalizeKey(hash);
    const base = this.getBaseIndex(hash);
    const idx0 = base;
    const idx1 = base + 1;

    const d0 = this.loadDepth(idx0);
    const d1 = this.loadDepth(idx1);

    let idx = -1;
    if (d0 !== 0 && this.loadKey(idx0) === key) idx = idx0;
    else if (d1 !== 0 && this.loadKey(idx1) === key) idx = idx1;

    if (idx === -1) {
      this.misses++;
      if (d0 !== 0 || d1 !== 0) this.collisions++;
      return [false, 0, null];
    }

    // Load fields, then re-check key to avoid torn reads (shared TT).
    const storedAge = this.loadAge(idx);
    const storedDepth = this.loadDepth(idx);
    const storedMoveCode = this.loadMoveCode(idx);
    const storedScoreRaw = this.loadScore(idx);
    const storedFlagCode = this.loadFlagCode(idx);
    const k2 = this.loadKey(idx);
    if (k2 !== key || storedDepth === 0) {
      return [false, 0, null];
    }

    this.countHit(storedAge);

    const bestMove = decodeMove(storedMoveCode);

    if (storedDepth < depth) {
      return [false, 0, bestMove];
    }
    
    // Convert stored TT score into the current node's score domain.
    // This matters for mate-distance (WIN_SCORE/LOSS_SCORE +/- ply) where ply is not
    // part of the TT key.
    const score = fromTTScore(storedScoreRaw, ply);
    const flag = codeToFlag(storedFlagCode);
    
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

