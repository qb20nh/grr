/**
 * Threat Detection and Fork Analysis
 * Identifies urgent tactical situations
 */

import { BOARD_CELLS } from './constants';
import type { Board, CellIndex, Color, Fork, PatternCounts } from './types';
import { ThreatLevel, EMPTY } from './types';
import { getOpponent } from './utils';
import { countPatterns, scanLine, classifyLine, countThreatsCreated } from './patterns';

// Candidate generation for fork detection (radius-2 neighborhood around any stone).
// Implemented locally to avoid cyclic deps with move generation.
const FORK_OFFSETS: readonly [number, number][] = (() => {
  const out: [number, number][] = [];
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      if (dr === 0 && dc === 0) continue;
      out.push([dr, dc]);
    }
  }
  return out;
})();

function forkCandidates(board: Board): CellIndex[] {
  const seen = new Uint8Array(BOARD_CELLS);
  const out: CellIndex[] = [];

  for (let pos = 0; pos < BOARD_CELLS; pos++) {
    if (board.cells[pos] === EMPTY) continue;
    const row = Math.floor(pos / 15);
    const col = pos % 15;

    for (const [dr, dc] of FORK_OFFSETS) {
      const r = row + dr;
      const c = col + dc;
      if (r < 0 || r >= 15 || c < 0 || c >= 15) continue;
      const idx = r * 15 + c;
      if (board.cells[idx] !== EMPTY) continue;
      if (board.koPosition === idx) continue;
      if (seen[idx]) continue;
      seen[idx] = 1;
      out.push(idx);
    }
  }

  return out;
}

/**
 * Determine the threat level from pattern counts
 */
export function getThreatLevel(patterns: PatternCounts): ThreatLevel {
  // Winning position
  if (patterns.FIVE > 0) {
    return ThreatLevel.WINNING;
  }
  
  // Critical: open four, gap four, or half-open four
  // HALF_FOUR is CRITICAL because opponent can win next turn if not blocked!
  if (patterns.OPEN_FOUR > 0 || patterns.GAP_FOUR > 0 || patterns.HALF_FOUR > 0) {
    return ThreatLevel.CRITICAL;
  }
  
  // Double three is also critical (unstoppable with 2-stone placement)
  if (patterns.OPEN_THREE >= 2) {
    return ThreatLevel.CRITICAL;
  }
  
  // Severe: multiple open threes or gap threes
  if (patterns.OPEN_THREE > 0 && patterns.GAP_THREE > 0) {
    return ThreatLevel.SEVERE;
  }
  
  // Moderate: open three needs attention
  if (patterns.OPEN_THREE > 0 || patterns.GAP_THREE > 0) {
    return ThreatLevel.MODERATE;
  }
  
  // Minor: some development
  if (patterns.HALF_THREE > 0 || patterns.OPEN_TWO > 0) {
    return ThreatLevel.MINOR;
  }
  
  return ThreatLevel.NONE;
}

/**
 * Check if player has a critical threat (must be responded to)
 */
export function hasCriticalThreat(board: Board, player: Color): boolean {
  const patterns = countPatterns(board, player);
  const level = getThreatLevel(patterns);
  return level >= ThreatLevel.CRITICAL;
}

/**
 * Check if player has a winning threat (can win next move)
 */
export function hasWinningThreat(board: Board, player: Color): boolean {
  const patterns = countPatterns(board, player);
  return patterns.FIVE > 0 || patterns.OPEN_FOUR > 0;
}

/**
 * Check if player can win on their next move
 * This checks for positions where placing a single stone wins
 */
export function canWinNextMove(board: Board, player: Color): boolean {
  const winningPositions = findWinningPositions(board, player);
  return winningPositions.length > 0;
}

/**
 * Detect forks (positions that create multiple threats)
 */
export function detectForks(board: Board, player: Color): Fork[] {
  const forks: Fork[] = [];

  const candidates = forkCandidates(board);
  for (const pos of candidates) {
    
    // Temporarily place stone
    board.cells[pos] = player;
    
    const threats: string[] = [];
    
    for (let dir = 0; dir < 4; dir++) {
      const info = scanLine(board, pos, dir, player);
      const pattern = classifyLine(info);
      
      // Count significant threats
      if (pattern === 'FIVE' ||
          pattern === 'OPEN_FOUR' ||
          pattern === 'GAP_FOUR' ||
          pattern === 'HALF_FOUR' ||
          pattern === 'OPEN_THREE') {
        threats.push(pattern);
      }
    }
    
    // Restore
    board.cells[pos] = EMPTY;
    
    // Fork requires at least 2 threats
    if (threats.length >= 2) {
      forks.push({
        position: pos,
        threats: threats as any[],
        count: threats.length,
      });
    }
  }
  
  return forks;
}

/**
 * Count forks for a player
 */
export function countForks(board: Board, player: Color): number {
  return detectForks(board, player).length;
}

/**
 * Find positions that block opponent's threats
 */
export function findBlockingPositions(board: Board, player: Color): CellIndex[] {
  const opponent = getOpponent(player);
  const blocking: Set<CellIndex> = new Set();
  
  // Find opponent's threatening positions
  for (let pos = 0; pos < BOARD_CELLS; pos++) {
    if (board.cells[pos] !== opponent) continue;
    
    for (let dir = 0; dir < 4; dir++) {
      const info = scanLine(board, pos, dir, opponent);
      const pattern = classifyLine(info);
      
      // If opponent has a threat, find blocking positions
      if (pattern === 'OPEN_FOUR' ||
          pattern === 'GAP_FOUR' ||
          pattern === 'HALF_FOUR' ||
          pattern === 'OPEN_THREE') {
        // Add extend positions as blocking candidates
        for (const extPos of info.extendPositions) {
          if (board.cells[extPos] === EMPTY && board.koPosition !== extPos) {
            blocking.add(extPos);
          }
        }
        // Add gap positions
        for (const gapPos of info.gapPositions) {
          if (board.cells[gapPos] === EMPTY && board.koPosition !== gapPos) {
            blocking.add(gapPos);
          }
        }
      }
    }
  }
  
  return Array.from(blocking);
}

/**
 * Find positions that create immediate wins
 */
export function findWinningPositions(board: Board, player: Color): CellIndex[] {
  // A single-stone win implies there exists a 4-threat (OPEN/HALF/GAP four).
  // Detect these by scanning existing stones (much faster than trying every empty cell).
  const winning = new Set<CellIndex>();

  for (let pos = 0; pos < BOARD_CELLS; pos++) {
    if (board.cells[pos] !== player) continue;

    for (let dir = 0; dir < 4; dir++) {
      const info = scanLine(board, pos, dir, player);
      const pattern = classifyLine(info);

      if (pattern === 'OPEN_FOUR' || pattern === 'HALF_FOUR') {
        for (const e of info.extendPositions) {
          winning.add(e);
        }
      } else if (pattern === 'GAP_FOUR') {
        for (const g of info.gapPositions) {
          winning.add(g);
        }
      }
    }
  }

  return Array.from(winning);
}

/**
 * Analyze threat situation for both players
 */
export interface ThreatAnalysis {
  playerLevel: ThreatLevel;
  opponentLevel: ThreatLevel;
  playerPatterns: PatternCounts;
  opponentPatterns: PatternCounts;
  playerForks: Fork[];
  opponentForks: Fork[];
  urgentBlocks: CellIndex[];
  winningMoves: CellIndex[];
}

export function analyzeThreatSituation(board: Board, player: Color): ThreatAnalysis {
  const opponent = getOpponent(player);
  
  const playerPatterns = countPatterns(board, player);
  const opponentPatterns = countPatterns(board, opponent);
  
  return {
    playerLevel: getThreatLevel(playerPatterns),
    opponentLevel: getThreatLevel(opponentPatterns),
    playerPatterns,
    opponentPatterns,
    playerForks: detectForks(board, player),
    opponentForks: detectForks(board, opponent),
    urgentBlocks: findBlockingPositions(board, player),
    winningMoves: findWinningPositions(board, player),
  };
}

/**
 * Check if a rift move would break a critical threat
 */
export function riftBreaksThreat(
  board: Board,
  riftPos: CellIndex,
  player: Color
): boolean {
  const opponent = getOpponent(player);
  
  // Check what patterns the opponent stone contributes to
  if (board.cells[riftPos] !== opponent) return false;
  
  for (let dir = 0; dir < 4; dir++) {
    const info = scanLine(board, riftPos, dir, opponent);
    const pattern = classifyLine(info);
    
    if (pattern === 'FIVE' ||
        pattern === 'OPEN_FOUR' ||
        pattern === 'GAP_FOUR' ||
        pattern === 'HALF_FOUR' ||
        pattern === 'OPEN_THREE') {
      return true;
    }
  }
  
  return false;
}

/**
 * Evaluate how valuable a rift target is
 */
export function evaluateRiftTarget(
  board: Board,
  riftPos: CellIndex,
  player: Color
): number {
  const opponent = getOpponent(player);
  if (board.cells[riftPos] !== opponent) return -Infinity;
  
  let value = 0;
  
  for (let dir = 0; dir < 4; dir++) {
    const info = scanLine(board, riftPos, dir, opponent);
    const pattern = classifyLine(info);
    
    // Score based on what pattern we're breaking
    switch (pattern) {
      case 'FIVE':
        value += 10000000; // Prevent loss
        break;
      case 'OPEN_FOUR':
        value += 500000;
        break;
      case 'GAP_FOUR':
        value += 200000;
        break;
      case 'HALF_FOUR':
        value += 50000;
        break;
      case 'OPEN_THREE':
        value += 20000;
        break;
      case 'GAP_THREE':
        value += 10000;
        break;
      case 'HALF_THREE':
        value += 2000;
        break;
      case 'OPEN_TWO':
        value += 500;
        break;
      case 'HALF_TWO':
        value += 100;
        break;
    }
  }
  
  // Bonus for breaking connectivity
  let neighbors = 0;
  const row = Math.floor(riftPos / 15);
  const col = riftPos % 15;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = row + dr;
      const nc = col + dc;
      if (nr >= 0 && nr < 15 && nc >= 0 && nc < 15) {
        if (board.cells[nr * 15 + nc] === opponent) {
          neighbors++;
        }
      }
    }
  }
  value += neighbors * 200;
  
  return value;
}

