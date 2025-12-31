/**
 * Position Evaluation Function
 * Comprehensive board evaluation for Gomoku Rift
 */

import { CONFIG, PATTERN_SCORES_SELF, PATTERN_SCORES_OPPONENT, FORK_BONUS, CENTER_BONUS, BOARD_CELLS } from './constants';
import type { Board, Color, PatternCounts, CellIndex } from './types';
import { ThreatLevel } from './types';
import { getOpponent } from './utils';
import { countPatterns } from './patterns';
import { getSingleStoneWinningSquares, getThreatLevel, detectForks } from './threats';
import type { NnueState } from './nnue/evaluator';

/**
 * Calculate pattern-based score
 */
function patternScore(patterns: PatternCounts, scores: typeof PATTERN_SCORES_SELF): number {
  // Hot path: avoid Object.entries allocations.
  return (
    patterns.FIVE * (scores.FIVE ?? 0) +
    patterns.OPEN_FOUR * (scores.OPEN_FOUR ?? 0) +
    patterns.GAP_FOUR * (scores.GAP_FOUR ?? 0) +
    patterns.HALF_FOUR * (scores.HALF_FOUR ?? 0) +
    patterns.OPEN_THREE * (scores.OPEN_THREE ?? 0) +
    patterns.GAP_THREE * (scores.GAP_THREE ?? 0) +
    patterns.HALF_THREE * (scores.HALF_THREE ?? 0) +
    patterns.OPEN_TWO * (scores.OPEN_TWO ?? 0) +
    patterns.HALF_TWO * (scores.HALF_TWO ?? 0)
  );
}

/**
 * Calculate fork bonus
 */
function calculateForkBonus(board: Board, player: Color): number {
  const forks = detectForks(board, player);
  let bonus = 0;
  
  for (const fork of forks) {
    // Classify fork type (allocation-free; avoid .filter()/.some() arrays)
    let fourCount = 0;
    let threeCount = 0;
    for (const t of fork.threats) {
      if (t === 'OPEN_FOUR' || t === 'GAP_FOUR' || t === 'HALF_FOUR') fourCount++;
      else if (t === 'OPEN_THREE') threeCount++;
    }
    
    if (fourCount >= 2) {
      bonus += FORK_BONUS.DOUBLE_FOUR;
    } else if (fourCount >= 1 && threeCount >= 1) {
      bonus += FORK_BONUS.FOUR_THREE;
    } else if (threeCount >= 3) {
      bonus += FORK_BONUS.TRIPLE_THREE;
    } else if (threeCount >= 2) {
      bonus += FORK_BONUS.DOUBLE_THREE;
    }
  }
  
  return bonus;
}

/**
 * Calculate center control bonus
 */
function centerControlScore(board: Board, player: Color): number {
  let score = 0;
  
  for (let i = 0; i < BOARD_CELLS; i++) {
    if (board.cells[i] === player) {
      score += CENTER_BONUS[i];
    }
  }
  
  return score;
}

/**
 * Calculate connectivity score (stones that support each other)
 */
function connectivityScore(board: Board, player: Color): number {
  let score = 0;
  
  for (let i = 0; i < BOARD_CELLS; i++) {
    if (board.cells[i] !== player) continue;
    
    const row = Math.floor(i / 15);
    const col = i % 15;
    
    // Count friendly neighbors
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = row + dr;
        const nc = col + dc;
        if (nr >= 0 && nr < 15 && nc >= 0 && nc < 15) {
          if (board.cells[nr * 15 + nc] === player) {
            score += 5; // Small bonus for each adjacent friendly stone
          }
        }
      }
    }
  }
  
  return score;
}

/**
 * Main evaluation function
 * Returns score from the perspective of the given player
 * Positive = good for player, negative = bad for player
 */
export function evaluateHandcrafted(board: Board, player: Color): number {
  const opponent = getOpponent(player);

  // Get pattern counts for both players (also serves as terminal detection).
  const ourPatterns = countPatterns(board, player);
  const theirPatterns = countPatterns(board, opponent);

  // Terminal conditions - exact five is a win (overline not counted as FIVE).
  if (ourPatterns.FIVE > 0) return CONFIG.WIN_SCORE;
  if (theirPatterns.FIVE > 0) return CONFIG.LOSS_SCORE;
  
  let score = 0;
  
  // 1. Pattern-based material score
  score += patternScore(ourPatterns, PATTERN_SCORES_SELF);
  score += patternScore(theirPatterns, PATTERN_SCORES_OPPONENT);
  
  // 2. Threat assessment (weighted heavily)
  const ourThreatLevel = getThreatLevel(ourPatterns);
  const theirThreatLevel = getThreatLevel(theirPatterns);
  
  // Critical threats are very important
  if (theirThreatLevel >= ThreatLevel.CRITICAL) {
    score -= 500000; // Urgent: must respond
  }
  if (ourThreatLevel >= ThreatLevel.CRITICAL) {
    score += 300000; // Good: we have forcing move
  }
  
  // Severe threats need attention
  if (theirThreatLevel >= ThreatLevel.SEVERE) {
    score -= 100000;
  }
  if (ourThreatLevel >= ThreatLevel.SEVERE) {
    score += 80000;
  }
  
  // 3. Fork detection and bonus (expensive) - only when tactically relevant.
  if (ourThreatLevel >= ThreatLevel.MODERATE || theirThreatLevel >= ThreatLevel.MODERATE) {
    score += calculateForkBonus(board, player);
    score -= calculateForkBonus(board, opponent) * CONFIG.THREAT_WEIGHT;
  }
  
  // 4. Positional factors
  score += centerControlScore(board, player);
  score -= centerControlScore(board, opponent) * 0.5;
  
  // 5. Connectivity
  score += connectivityScore(board, player);
  score -= connectivityScore(board, opponent) * 0.3;
  
  // 6. Material balance (slight bonus for more stones)
  score += (board.blackCount - board.whiteCount) * (player === 1 ? 10 : -10);
  
  return score;
}

/**
 * Back-compat alias: existing engine code historically imported `evaluate`.
 */
export const evaluate = evaluateHandcrafted;

/**
 * Search evaluation entrypoint.
 *
 * When NNUE is available we use it as the hot-path leaf eval.
 * When NNUE is unavailable (missing/corrupt weights), we fall back to the handcrafted eval.
 */
export function evaluateSearch(board: Board, player: Color, nnue: NnueState | null): number {
  if (nnue) {
    const v = nnue.evaluateValue(board, player); // [-1, 1]
    // Clamp defensively against any NaN/Infinity coming from bad weights.
    if (!Number.isFinite(v)) {
      return evaluateHandcrafted(board, player);
    }
    return Math.round(v * CONFIG.NNUE_VALUE_SCALE);
  }

  return evaluateHandcrafted(board, player);
}

/**
 * Quick static evaluation for move ordering
 * Faster than full evaluation, used for sorting moves
 */
export function quickEvaluate(board: Board, player: Color): number {
  const opponent = getOpponent(player);

  // Simple pattern-based score (also detects terminal FIVE).
  const ourPatterns = countPatterns(board, player);
  const theirPatterns = countPatterns(board, opponent);

  if (ourPatterns.FIVE > 0) return CONFIG.WIN_SCORE;
  if (theirPatterns.FIVE > 0) return CONFIG.LOSS_SCORE;

  return patternScore(ourPatterns, PATTERN_SCORES_SELF) + patternScore(theirPatterns, PATTERN_SCORES_OPPONENT);
}

/**
 * Evaluate a position after making a move
 * Used in quiescence search
 */
export function evaluateAfterMove(
  board: Board,
  player: Color,
  movedPositions: CellIndex[]
): number {
  // Focus evaluation on the moved positions for speed
  let score = 0;
  const opponent = getOpponent(player);
  
  // Check for wins at moved positions
  for (const pos of movedPositions) {
    if (board.cells[pos] === player) {
      // Check all directions for this stone
      for (let dir = 0; dir < 4; dir++) {
        // Quick line count
        let count = 1;
        const [dRow, dCol] = [[0,1],[1,0],[1,1],[1,-1]][dir];
        const row = Math.floor(pos / 15);
        const col = pos % 15;
        
        // Forward
        let r = row + dRow, c = col + dCol;
        while (r >= 0 && r < 15 && c >= 0 && c < 15 && board.cells[r*15+c] === player) {
          count++; r += dRow; c += dCol;
        }
        
        // Backward
        r = row - dRow; c = col - dCol;
        while (r >= 0 && r < 15 && c >= 0 && c < 15 && board.cells[r*15+c] === player) {
          count++; r -= dRow; c -= dCol;
        }
        
        if (count === 5) return CONFIG.WIN_SCORE;
        if (count >= 4) score += 100000;
        if (count >= 3) score += 5000;
      }
    }
  }
  
  // Fall back to full evaluation for accuracy
  return evaluateHandcrafted(board, player);
}

/**
 * Determine if the position is tactically quiet
 * Used to decide whether to extend quiescence search
 */
export function isQuietPosition(board: Board, player: Color): boolean {
  const opponent = getOpponent(player);

  // Threat-driven quiescence guardrails:
  // - If the side-to-move can win immediately (Ko-respecting), it's tactical.
  if (getSingleStoneWinningSquares(board, player, 'respectKo').length > 0) return false;

  // - If the opponent has a win square that would be available on their next turn (Ko-clears),
  //   the position is tactically unstable (common around Ko).
  if (getSingleStoneWinningSquares(board, opponent, 'ignoreKo').length > 0) return false;

  // - Critical threats for either side keep the position “noisy”.
  const ourPatterns = countPatterns(board, player);
  const theirPatterns = countPatterns(board, opponent);
  if (getThreatLevel(ourPatterns) >= ThreatLevel.CRITICAL) return false;
  if (getThreatLevel(theirPatterns) >= ThreatLevel.CRITICAL) return false;

  return true;
}

