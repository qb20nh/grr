/**
 * Time Management for AI Search
 * Adaptive time allocation based on game phase and position
 */

import { CONFIG, BOARD_CELLS } from './constants';
import type { Board, Color, GamePhase } from './types';
import { getThreatLevel, hasCriticalThreat } from './threats';
import { countPatterns } from './patterns';
import { getOpponent } from './utils';

/**
 * Determine the current game phase based on stone count
 */
export function getGamePhase(board: Board): GamePhase {
  const totalStones = board.blackCount + board.whiteCount;
  
  // Opening: first ~20 stones (10 moves per player)
  if (totalStones < 20) {
    return 'opening';
  }
  
  // Endgame: board more than 40% full
  if (totalStones > BOARD_CELLS * 0.4) {
    return 'endgame';
  }
  
  return 'midgame';
}

/**
 * Calculate estimated remaining moves in the game
 */
export function estimateRemainingMoves(board: Board): number {
  const totalStones = board.blackCount + board.whiteCount;
  const emptySpaces = BOARD_CELLS - totalStones;
  
  // Each move places 2 stones (reinforce) or removes 1 (rift)
  // Estimate about 2 stones per move on average
  const estimatedMoves = Math.ceil(emptySpaces / 4);
  
  // Games usually end before board is full due to wins
  return Math.min(estimatedMoves, 50);
}

/**
 * Check if the position is under immediate threat
 */
export function isUnderThreat(board: Board, player: Color): boolean {
  const opponent = getOpponent(player);
  return hasCriticalThreat(board, opponent);
}

/**
 * Check if we have a strong attack going
 */
export function hasStrongAttack(board: Board, player: Color): boolean {
  return hasCriticalThreat(board, player);
}

/**
 * Calculate complexity of position (for time allocation)
 */
export function getPositionComplexity(board: Board, player: Color): number {
  const opponent = getOpponent(player);
  
  const ourPatterns = countPatterns(board, player);
  const theirPatterns = countPatterns(board, opponent);
  
  // More patterns = more complex position
  let complexity = 0;
  
  // Count significant patterns
  complexity += ourPatterns.OPEN_FOUR * 10;
  complexity += ourPatterns.HALF_FOUR * 5;
  complexity += ourPatterns.OPEN_THREE * 3;
  complexity += theirPatterns.OPEN_FOUR * 10;
  complexity += theirPatterns.HALF_FOUR * 5;
  complexity += theirPatterns.OPEN_THREE * 3;
  
  // Stone count affects complexity
  complexity += board.blackCount + board.whiteCount;
  
  return complexity;
}

/**
 * Calculate time allocation for the current move
 */
export function calculateTimeForMove(
  board: Board,
  player: Color,
  baseTime: number = CONFIG.DEFAULT_TIME
): number {
  const phase = getGamePhase(board);
  const remainingMoves = estimateRemainingMoves(board);
  const underThreat = isUnderThreat(board, player);
  const hasAttack = hasStrongAttack(board, player);
  const complexity = getPositionComplexity(board, player);
  
  let multiplier = 1.0;
  
  // Phase adjustments
  switch (phase) {
    case 'opening':
      // Opening moves are less critical, can be faster
      multiplier *= 0.6;
      break;
    case 'midgame':
      // Midgame is where most decisions happen
      multiplier *= 1.0;
      break;
    case 'endgame':
      // Endgame moves are critical
      multiplier *= 1.3;
      break;
  }
  
  // Threat adjustments
  if (underThreat) {
    // Need more time to find defense
    multiplier *= 1.5;
  }
  
  if (hasAttack) {
    // Have initiative, but need to find best continuation
    multiplier *= 1.2;
  }
  
  // Complexity adjustment
  if (complexity > 50) {
    multiplier *= 1.3;
  } else if (complexity > 30) {
    multiplier *= 1.1;
  } else if (complexity < 10) {
    multiplier *= 0.8;
  }
  
  // Remaining moves adjustment (save time for later)
  if (remainingMoves < 10) {
    multiplier *= 1.4; // Critical endgame
  } else if (remainingMoves > 30) {
    multiplier *= 0.9; // Plenty of game left
  }
  
  // Calculate final time
  const time = baseTime * multiplier;
  
  // Clamp to bounds
  return Math.max(CONFIG.MIN_TIME, Math.min(CONFIG.MAX_TIME, Math.round(time)));
}

/**
 * Emergency time - minimum time for critical decisions
 */
export function getEmergencyTime(): number {
  return CONFIG.MIN_TIME;
}

/**
 * Time for obvious moves (wins, forced responses)
 */
export function getQuickMoveTime(): number {
  return Math.round(CONFIG.MIN_TIME * 1.5);
}

/**
 * Check if we should extend search time
 */
export function shouldExtendTime(
  elapsedTime: number,
  allocatedTime: number,
  scoreChange: number
): boolean {
  // If we've used less than 70% of allocated time and score changed significantly
  if (elapsedTime < allocatedTime * 0.7 && Math.abs(scoreChange) > 50000) {
    return true;
  }
  
  return false;
}

/**
 * Time management state for iterative deepening
 */
export interface TimeState {
  startTime: number;
  allocatedTime: number;
  hardLimit: number;
  lastScore: number;
  canExtend: boolean;
}

export function createTimeState(allocatedTime: number): TimeState {
  return {
    startTime: Date.now(),
    allocatedTime,
    hardLimit: allocatedTime * 1.5, // Can extend up to 50%
    lastScore: 0,
    canExtend: true,
  };
}

export function shouldStopSearch(state: TimeState, currentScore: number): boolean {
  const elapsed = Date.now() - state.startTime;
  
  // Hard limit - always stop
  if (elapsed >= state.hardLimit) {
    return true;
  }
  
  // Soft limit
  if (elapsed >= state.allocatedTime) {
    // Check if we should extend
    if (state.canExtend && shouldExtendTime(elapsed, state.allocatedTime, currentScore - state.lastScore)) {
      state.canExtend = false; // Only extend once
      return false;
    }
    return true;
  }
  
  state.lastScore = currentScore;
  return false;
}

