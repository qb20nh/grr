/**
 * Zobrist Hashing for transposition table
 * Uses 64-bit random values for collision-resistant position identification
 */

import { BOARD_CELLS } from './constants';
import type { Board, CellIndex, Color } from './types';
import { BLACK, WHITE } from './types';

/**
 * Seeded pseudo-random generator for reproducibility
 * Using a simple LCG (Linear Congruential Generator)
 */
const rng = (() => {
  let seed = 0x12345678n;
  const a = 6364136223846793005n;
  const c = 1442695040888963407n;
  const m = 1n << 64n;
  
  function nextRandom(): bigint {
    seed = (a * seed + c) % m;
    return seed;
  }
  return { nextRandom };
})();

/**
 * Pre-generated random 64-bit values for stone placement hashing
 * Index: position * 2 + (color - 1)  (color is 1 for BLACK, 2 for WHITE)
 *
 * Using BigInt for 64-bit precision in JavaScript
 */
const ZOBRIST_TABLE: bigint[] = (() => {
  const table: bigint[] = [];
  // 225 positions * 2 colors = 450 entries
  for (let i = 0; i < BOARD_CELLS * 2; i++) {
    table.push(rng.nextRandom());
  }
  return table;
})();

/**
 * Hash values for Ko position (position blocked for one move).
 * This is part of the game state and must be included in the TT key.
 */
const KO_TABLE: bigint[] = (() => {
  const table: bigint[] = [];
  for (let i = 0; i < BOARD_CELLS; i++) {
    table.push(rng.nextRandom());
  }
  return table;
})();

/**
 * Hash values for side-to-move (TT key only).
 * Index by Color (1 = BLACK, 2 = WHITE).
 */
const TURN_HASH: readonly bigint[] = [0n, rng.nextRandom(), rng.nextRandom()] as const;

/**
 * Get the Zobrist hash index for a position and color
 */
function getHashIndex(pos: CellIndex, color: Color): number {
  // color is 1 (BLACK) or 2 (WHITE), convert to 0 or 1
  return pos * 2 + (color - 1);
}

/**
 * Update hash when placing or removing a stone
 * XOR is self-inverse, so same operation for place and remove
 */
export function updateHash(hash: bigint, pos: CellIndex, color: Color): bigint {
  return hash ^ ZOBRIST_TABLE[getHashIndex(pos, color)];
}

/**
 * Update hash when Ko position changes.
 * XOR is self-inverse, so toggling previous and next Ko is sufficient.
 */
export function updateKoHash(hash: bigint, prevKo: CellIndex | null, nextKo: CellIndex | null): bigint {
  let h = hash;
  if (prevKo !== null) {
    h ^= KO_TABLE[prevKo];
  }
  if (nextKo !== null) {
    h ^= KO_TABLE[nextKo];
  }
  return h;
}

/**
 * Add side-to-move to a hash (TT key only).
 */
export function withTurn(hash: bigint, player: Color): bigint {
  return hash ^ TURN_HASH[player];
}

/**
 * Compute full hash for a board from scratch
 */
export function computeFullHash(board: Board): bigint {
  let hash = 0n;
  
  for (let i = 0; i < BOARD_CELLS; i++) {
    const cell = board.cells[i];
    if (cell === BLACK || cell === WHITE) {
      hash ^= ZOBRIST_TABLE[getHashIndex(i, cell)];
    }
  }

  if (board.koPosition !== null) {
    hash ^= KO_TABLE[board.koPosition];
  }
  
  return hash;
}

/**
 * Get the raw Zobrist table value (for debugging/testing)
 */
export function getZobristValue(pos: CellIndex, color: Color): bigint {
  return ZOBRIST_TABLE[getHashIndex(pos, color)];
}

