/**
 * Constants and configuration for the AI engine
 */

import { PatternType } from './types';

// Board dimensions
export const BOARD_SIZE = 15;
export const BOARD_CELLS = BOARD_SIZE * BOARD_SIZE; // 225

// Direction vectors for line scanning (row delta, col delta)
// 0: horizontal, 1: vertical, 2: diagonal down-right, 3: diagonal down-left
export const DIRECTIONS: readonly [number, number][] = [
  [0, 1],   // horizontal
  [1, 0],   // vertical
  [1, 1],   // diagonal down-right
  [1, -1],  // diagonal down-left
] as const;

// Direction deltas as flat index offsets
export const DIR_OFFSETS: readonly number[] = [
  1,                    // horizontal: +1 col
  BOARD_SIZE,           // vertical: +1 row
  BOARD_SIZE + 1,       // diagonal down-right
  BOARD_SIZE - 1,       // diagonal down-left
] as const;

// Search configuration
export const CONFIG = {
  // Transposition table
  TT_SIZE: 1 << 22,           // ~4M entries (typed-array TT)
  TT_MASK: (1 << 22) - 1,     // For fast modulo
  
  // Move generation limits
  MAX_CANDIDATES: 40,         // Single position candidates
  MAX_PAIRS: 50,              // Reinforce pairs to search
  MAX_RIFTS: 15,              // Rift targets to search
  CANDIDATE_RADIUS: 2,        // Cells from existing stones
  
  // Search parameters
  MAX_DEPTH: 20,              // Maximum search depth
  KILLER_SLOTS: 2,            // Killer moves per depth
  QUIESCENCE_DEPTH: 4,        // Max quiescence plies
  
  // Time management
  DEFAULT_TIME: 5000,         // Default time per move (ms)
  MIN_TIME: 100,              // Minimum time per move
  MAX_TIME: 10000,            // Maximum time per move
  
  // Evaluation thresholds
  RIFT_THRESHOLD: 1.3,        // Rift must beat reinforce by 30%
  THREAT_WEIGHT: 2.5,         // Opponent threats weighted higher
  
  // Score bounds
  INFINITY: 10000000,
  WIN_SCORE: 9000000,
  LOSS_SCORE: -9000000,
} as const;

// Pattern scores - self (positive when we have them)
export const PATTERN_SCORES_SELF: Record<PatternType, number> = {
  [PatternType.FIVE]: 10000000,
  [PatternType.OPEN_FOUR]: 500000,
  [PatternType.HALF_FOUR]: 50000,
  [PatternType.OPEN_THREE]: 5000,
  [PatternType.HALF_THREE]: 500,
  [PatternType.OPEN_TWO]: 100,
  [PatternType.HALF_TWO]: 20,
  [PatternType.GAP_FOUR]: 100000,
  [PatternType.GAP_THREE]: 2000,
};

// Pattern scores - opponent (negative, weighted higher for urgency)
export const PATTERN_SCORES_OPPONENT: Record<PatternType, number> = {
  [PatternType.FIVE]: -10000000,
  [PatternType.OPEN_FOUR]: -1000000,   // Must block immediately
  [PatternType.HALF_FOUR]: -100000,
  [PatternType.OPEN_THREE]: -20000,
  [PatternType.HALF_THREE]: -2000,
  [PatternType.OPEN_TWO]: -200,
  [PatternType.HALF_TWO]: -40,
  [PatternType.GAP_FOUR]: -200000,
  [PatternType.GAP_THREE]: -5000,
};

// Fork bonus (having multiple threats)
export const FORK_BONUS = {
  DOUBLE_FOUR: 800000,        // Two fours = unstoppable
  FOUR_THREE: 400000,         // Four + three = very strong
  DOUBLE_THREE: 200000,       // Two open threes
  TRIPLE_THREE: 600000,       // Three open threes (rare)
};

// Positional bonus for center control
// Pre-computed: higher values near center
export const CENTER_BONUS: number[] = (() => {
  const bonus = new Array(BOARD_CELLS);
  const center = Math.floor(BOARD_SIZE / 2);
  for (let i = 0; i < BOARD_CELLS; i++) {
    const row = Math.floor(i / BOARD_SIZE);
    const col = i % BOARD_SIZE;
    const distFromCenter = Math.abs(row - center) + Math.abs(col - center);
    bonus[i] = Math.max(0, (14 - distFromCenter) * 2);
  }
  return bonus;
})();

// Synergy bonuses for two-stone placement
export const SYNERGY_BONUS = {
  SAME_LINE_EXTENSION: 2000,  // Both extend same potential five
  DUAL_THREAT: 3000,          // Base per threat created
  ATTACK_DEFEND: 5000,        // One attacks, one defends
  PROXIMITY_CLOSE: 500,       // Distance <= 3
  PROXIMITY_MEDIUM: 200,      // Distance <= 5
  SHIELD_JUMP: 1000,          // Using shield exception tactically
};

