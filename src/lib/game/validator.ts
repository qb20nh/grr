import type { Stone, Position, PlayerColor } from './types';
import { BOARD_SIZE, positionsEqual, getOpponent } from './types';
import { checkWinAtPosition } from './winChecker';

/**
 * Checks if a position is valid for placement.
 * A position is invalid if:
 * - It's outside the board
 * - It's already occupied
 * - It's the Ko-blocked position (just rifted)
 */
export function isValidPlacement(
  board: Stone[][],
  pos: Position,
  lastRiftedPosition: Position | null
): boolean {
  if (pos.row < 0 || pos.row >= BOARD_SIZE || pos.col < 0 || pos.col >= BOARD_SIZE) {
    return false;
  }
  
  if (board[pos.row][pos.col] !== null) {
    return false;
  }
  
  if (positionsEqual(pos, lastRiftedPosition)) {
    return false;
  }
  
  return true;
}

/**
 * Checks if two positions are colinear (on the same horizontal, vertical, or diagonal line).
 */
function areColinear(pos1: Position, pos2: Position): [boolean, [number, number] | null] {
  const dRow = pos2.row - pos1.row;
  const dCol = pos2.col - pos1.col;

  // Same position
  if (dRow === 0 && dCol === 0) {
    return [false, null];
  }

  // Horizontal
  if (dRow === 0) {
    return [true, [0, dCol > 0 ? 1 : -1]];
  }

  // Vertical
  if (dCol === 0) {
    return [true, [dRow > 0 ? 1 : -1, 0]];
  }

  // Diagonal (must have equal absolute differences)
  if (Math.abs(dRow) === Math.abs(dCol)) {
    return [true, [dRow > 0 ? 1 : -1, dCol > 0 ? 1 : -1]];
  }

  return [false, null];
}

/**
 * Checks if placing two stones violates the colinearity constraint.
 * 
 * Colinearity Constraint: The two stones cannot be placed on the same line 
 * (horizontal, vertical, or diagonal) if the path between them is clear 
 * or only obstructed by the player's own stones.
 * 
 * Shield Exception: The two stones CAN be placed on the same line if and only if 
 * there is at least one opponent's stone directly between them.
 * 
 * Returns true if the move is VALID (no violation or shield exception applies).
 */
export function checkColinearityConstraint(
  board: Stone[][],
  pos1: Position,
  pos2: Position,
  currentPlayer: PlayerColor
): boolean {
  const [colinear, direction] = areColinear(pos1, pos2);
  
  // If not colinear, no constraint violation
  if (!colinear || !direction) {
    return true;
  }

  const [dRow, dCol] = direction;
  const opponent = getOpponent(currentPlayer);
  
  // Walk from pos1 toward pos2 and check for opponent stones
  let row = pos1.row + dRow;
  let col = pos1.col + dCol;
  let foundOpponentStone = false;
  
  while (row !== pos2.row || col !== pos2.col) {
    const stone = board[row][col];
    
    if (stone === opponent) {
      foundOpponentStone = true;
      break;
    }
    
    row += dRow;
    col += dCol;
  }

  // If we found an opponent's stone between them (Shield Exception), it's valid
  return foundOpponentStone;
}

/**
 * Checks if placing a single stone at the given position would immediately win.
 */
export function wouldWinWithSingleStone(
  board: Stone[][],
  pos: Position,
  player: PlayerColor
): boolean {
  if (!isValidPlacement(board, pos, null)) {
    return false;
  }
  
  // Temporarily place the stone
  const tempBoard = board.map(row => [...row]);
  tempBoard[pos.row][pos.col] = player;
  
  // Check if this creates exactly 5 in a row
  return checkWinAtPosition(tempBoard, pos, player);
}

/**
 * Validates a complete reinforce action (placing one or two stones).
 * Single stone placement is only allowed if it immediately wins.
 */
export function validateReinforceAction(
  board: Stone[][],
  positions: Position[],
  currentPlayer: PlayerColor,
  lastRiftedPosition: Position | null
): { valid: boolean; reason?: string; isWinningMove?: boolean } {
  // Single stone placement - only valid if it wins
  if (positions.length === 1) {
    const pos = positions[0];
    
    if (!isValidPlacement(board, pos, lastRiftedPosition)) {
      return { valid: false, reason: 'Position is invalid' };
    }
    
    if (wouldWinWithSingleStone(board, pos, currentPlayer)) {
      return { valid: true, isWinningMove: true };
    }
    
    return { valid: false, reason: 'Single stone placement only allowed when it wins' };
  }
  
  if (positions.length !== 2) {
    return { valid: false, reason: 'Must place 1 or 2 stones' };
  }

  const [pos1, pos2] = positions;

  // Check both positions are valid for placement
  if (!isValidPlacement(board, pos1, lastRiftedPosition)) {
    return { valid: false, reason: 'First position is invalid' };
  }
  
  if (!isValidPlacement(board, pos2, lastRiftedPosition)) {
    return { valid: false, reason: 'Second position is invalid' };
  }

  // Check they're not the same position
  if (positionsEqual(pos1, pos2)) {
    return { valid: false, reason: 'Cannot place both stones at the same position' };
  }

  // Check colinearity constraint
  if (!checkColinearityConstraint(board, pos1, pos2, currentPlayer)) {
    return { 
      valid: false, 
      reason: 'Stones cannot be placed on the same line unless an opponent stone is between them' 
    };
  }

  return { valid: true };
}

/**
 * Validates a rift action (removing one opponent stone).
 */
export function validateRiftAction(
  board: Stone[][],
  pos: Position,
  currentPlayer: PlayerColor
): { valid: boolean; reason?: string } {
  if (pos.row < 0 || pos.row >= BOARD_SIZE || pos.col < 0 || pos.col >= BOARD_SIZE) {
    return { valid: false, reason: 'Position is outside the board' };
  }

  const stone = board[pos.row][pos.col];
  const opponent = getOpponent(currentPlayer);
  
  if (stone !== opponent) {
    return { valid: false, reason: 'Can only remove opponent stones' };
  }

  return { valid: true };
}

/**
 * Gets all valid placement positions for the current state.
 */
export function getValidPlacements(
  board: Stone[][],
  lastRiftedPosition: Position | null,
  pendingPlacement: Position | null,
  currentPlayer: PlayerColor
): Position[] {
  const validPositions: Position[] = [];

  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      const pos = { row, col };
      
      if (!isValidPlacement(board, pos, lastRiftedPosition)) {
        continue;
      }

      // If there's a pending placement, check colinearity
      if (pendingPlacement && positionsEqual(pos, pendingPlacement)) {
        continue;
      }

      if (pendingPlacement && !checkColinearityConstraint(board, pendingPlacement, pos, currentPlayer)) {
        continue;
      }

      validPositions.push(pos);
    }
  }

  return validPositions;
}

/**
 * Gets all opponent stones that can be rifted.
 */
export function getValidRiftTargets(
  board: Stone[][],
  currentPlayer: PlayerColor
): Position[] {
  const opponent = getOpponent(currentPlayer);
  const targets: Position[] = [];

  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      if (board[row][col] === opponent) {
        targets.push({ row, col });
      }
    }
  }

  return targets;
}

