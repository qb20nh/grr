/**
 * Synergy Scoring for Two-Stone Placement
 * Evaluates how well two stones work together
 */

import { BOARD_SIZE, SYNERGY_BONUS, DIRECTIONS } from './constants';
import type { Board, CellIndex, Color } from './types';
import { EMPTY } from './types';
import { manhattanDistance, getOpponent, areColinear, getPositionsBetween, toIndex, inBounds } from './utils';
import { scanLine, classifyLine, countThreatsCreated } from './patterns';
import { hasCriticalThreat, findBlockingPositions } from './threats';

/**
 * Check if two positions use the Shield Exception (colinear with opponent between)
 */
export function usesShieldException(
  board: Board,
  pos1: CellIndex,
  pos2: CellIndex,
  player: Color
): boolean {
  const [colinear, direction] = areColinear(pos1, pos2);
  if (!colinear || !direction) return false;
  
  const opponent = getOpponent(player);
  const between = getPositionsBetween(pos1, pos2);
  
  for (const pos of between) {
    if (board.cells[pos] === opponent) {
      return true;
    }
  }
  
  return false;
}

/**
 * Check if two positions extend the same potential five-in-a-row
 */
export function extendsSameLine(
  board: Board,
  pos1: CellIndex,
  pos2: CellIndex,
  player: Color
): boolean {
  // Check each direction from pos1
  for (let dir = 0; dir < 4; dir++) {
    const [dRow, dCol] = DIRECTIONS[dir];
    const r1 = Math.floor(pos1 / BOARD_SIZE);
    const c1 = pos1 % BOARD_SIZE;
    const r2 = Math.floor(pos2 / BOARD_SIZE);
    const c2 = pos2 % BOARD_SIZE;
    
    // Check if pos2 is on the same line as pos1 in this direction
    const dr = r2 - r1;
    const dc = c2 - c1;
    
    if (dr === 0 && dc === 0) continue;
    
    // Check if direction matches
    if (dRow === 0 && dr !== 0) continue;
    if (dCol === 0 && dc !== 0) continue;
    if (dRow !== 0 && dCol !== 0) {
      if (Math.abs(dr) !== Math.abs(dc)) continue;
      if ((dr > 0) !== (dRow > 0) && (dr < 0) !== (dRow < 0)) continue;
      if ((dc > 0) !== (dCol > 0) && (dc < 0) !== (dCol < 0)) continue;
    }
    
    // Both positions extend the same line if placing both creates a longer line
    // Temporarily place both
    const orig1 = board.cells[pos1];
    const orig2 = board.cells[pos2];
    board.cells[pos1] = player;
    board.cells[pos2] = player;
    
    const info1 = scanLine(board, pos1, dir, player);
    
    // Restore
    board.cells[pos1] = orig1;
    board.cells[pos2] = orig2;
    
    // If the line through pos1 includes pos2, they extend the same line
    if (info1.count >= 2) {
      return true;
    }
  }
  
  return false;
}

/**
 * Check if a position blocks an opponent threat
 */
export function blocksOpponentThreat(
  board: Board,
  pos: CellIndex,
  player: Color
): boolean {
  const blockingPositions = findBlockingPositions(board, player);
  return blockingPositions.includes(pos);
}

/**
 * Check if a position creates a winning threat
 */
export function createsWinningThreat(
  board: Board,
  pos: CellIndex,
  player: Color
): boolean {
  const orig = board.cells[pos];
  board.cells[pos] = player;
  
  let creates = false;
  for (let dir = 0; dir < 4; dir++) {
    const info = scanLine(board, pos, dir, player);
    const pattern = classifyLine(info);
    if (pattern === 'FIVE' || pattern === 'OPEN_FOUR') {
      creates = true;
      break;
    }
  }
  
  board.cells[pos] = orig;
  return creates;
}

/**
 * Calculate synergy score for a two-stone placement
 */
export function evaluatePairSynergy(
  board: Board,
  pos1: CellIndex,
  pos2: CellIndex,
  player: Color
): number {
  let synergy = 0;
  
  // 1. Both extend toward same potential five (using Shield Exception)
  if (usesShieldException(board, pos1, pos2, player)) {
    synergy += SYNERGY_BONUS.SHIELD_JUMP;
    
    // Additional bonus if they actually extend the same line
    if (extendsSameLine(board, pos1, pos2, player)) {
      synergy += SYNERGY_BONUS.SAME_LINE_EXTENSION;
    }
  }
  
  // 2. Create fork (two separate threats)
  // Place both stones temporarily
  const orig1 = board.cells[pos1];
  const orig2 = board.cells[pos2];
  board.cells[pos1] = player;
  board.cells[pos2] = player;
  
  const threats1 = countThreatsAtPosition(board, pos1, player);
  const threats2 = countThreatsAtPosition(board, pos2, player);
  
  // Restore
  board.cells[pos1] = orig1;
  board.cells[pos2] = orig2;
  
  const totalThreats = threats1 + threats2;
  if (totalThreats >= 2) {
    synergy += SYNERGY_BONUS.DUAL_THREAT * totalThreats;
  }
  
  // 3. One attacks, one defends critical threat
  const attacks1 = createsWinningThreat(board, pos1, player);
  const attacks2 = createsWinningThreat(board, pos2, player);
  const blocks1 = blocksOpponentThreat(board, pos1, player);
  const blocks2 = blocksOpponentThreat(board, pos2, player);
  
  if ((attacks1 && blocks2) || (attacks2 && blocks1)) {
    synergy += SYNERGY_BONUS.ATTACK_DEFEND;
  }
  
  // 4. Spatial proximity (connected development)
  const distance = manhattanDistance(pos1, pos2);
  if (distance <= 3) {
    synergy += SYNERGY_BONUS.PROXIMITY_CLOSE;
  } else if (distance <= 5) {
    synergy += SYNERGY_BONUS.PROXIMITY_MEDIUM;
  }
  
  return synergy;
}

/**
 * Count threats at a specific position (stone already placed)
 */
function countThreatsAtPosition(
  board: Board,
  pos: CellIndex,
  player: Color
): number {
  let threats = 0;
  
  for (let dir = 0; dir < 4; dir++) {
    const info = scanLine(board, pos, dir, player);
    const pattern = classifyLine(info);
    
    if (pattern === 'FIVE' ||
        pattern === 'OPEN_FOUR' ||
        pattern === 'GAP_FOUR' ||
        pattern === 'HALF_FOUR' ||
        pattern === 'OPEN_THREE') {
      threats++;
    }
  }
  
  return threats;
}

/**
 * Evaluate how good a single position is for placement
 */
export function evaluateSinglePosition(
  board: Board,
  pos: CellIndex,
  player: Color
): number {
  const opponent = getOpponent(player);
  let score = 0;
  
  // Temporarily place
  const orig = board.cells[pos];
  board.cells[pos] = player;
  
  // Score based on patterns created
  for (let dir = 0; dir < 4; dir++) {
    const info = scanLine(board, pos, dir, player);
    const pattern = classifyLine(info);
    
    switch (pattern) {
      case 'FIVE':
        score += 10000000;
        break;
      case 'OPEN_FOUR':
        score += 500000;
        break;
      case 'GAP_FOUR':
        score += 100000;
        break;
      case 'HALF_FOUR':
        score += 50000;
        break;
      case 'OPEN_THREE':
        score += 5000;
        break;
      case 'GAP_THREE':
        score += 2000;
        break;
      case 'HALF_THREE':
        score += 500;
        break;
      case 'OPEN_TWO':
        score += 100;
        break;
      case 'HALF_TWO':
        score += 20;
        break;
    }
  }
  
  // Restore
  board.cells[pos] = orig;
  
  // Check if this blocks opponent threats
  if (blocksOpponentThreat(board, pos, player)) {
    // Evaluate what we're blocking
    board.cells[pos] = opponent;
    for (let dir = 0; dir < 4; dir++) {
      const info = scanLine(board, pos, dir, opponent);
      const pattern = classifyLine(info);
      
      switch (pattern) {
        case 'FIVE':
          score += 9000000; // Must block this
          break;
        case 'OPEN_FOUR':
          score += 400000;
          break;
        case 'GAP_FOUR':
          score += 150000;
          break;
        case 'HALF_FOUR':
          score += 40000;
          break;
        case 'OPEN_THREE':
          score += 3000;
          break;
      }
    }
    board.cells[pos] = orig;
  }
  
  // Center bonus
  const row = Math.floor(pos / BOARD_SIZE);
  const col = pos % BOARD_SIZE;
  const center = Math.floor(BOARD_SIZE / 2);
  const distFromCenter = Math.abs(row - center) + Math.abs(col - center);
  score += Math.max(0, (14 - distFromCenter) * 2);
  
  return score;
}

/**
 * Evaluate a complete reinforce move (both stones)
 */
export function evaluateReinforceMove(
  board: Board,
  pos1: CellIndex,
  pos2: CellIndex,
  player: Color
): number {
  // Individual position scores
  const score1 = evaluateSinglePosition(board, pos1, player);
  const score2 = evaluateSinglePosition(board, pos2, player);
  
  // Synergy bonus
  const synergy = evaluatePairSynergy(board, pos1, pos2, player);
  
  // Check for immediate win
  const orig1 = board.cells[pos1];
  const orig2 = board.cells[pos2];
  board.cells[pos1] = player;
  board.cells[pos2] = player;
  
  let wins = false;
  for (let dir = 0; dir < 4; dir++) {
    const info1 = scanLine(board, pos1, dir, player);
    const info2 = scanLine(board, pos2, dir, player);
    if ((info1.count === 5 && info1.gaps === 0) ||
        (info2.count === 5 && info2.gaps === 0)) {
      wins = true;
      break;
    }
  }
  
  board.cells[pos1] = orig1;
  board.cells[pos2] = orig2;
  
  if (wins) {
    return 10000000; // Winning move
  }
  
  return score1 + score2 + synergy;
}

