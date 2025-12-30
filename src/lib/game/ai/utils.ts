/**
 * Utility functions for the AI engine
 */

import { BOARD_SIZE, BOARD_CELLS } from './constants';
import type { Position, CellIndex, Color, Move, ReinforceMove, RiftMove, SingleWinMove } from './types';
import { BLACK, WHITE } from './types';

/**
 * Convert row/col to flat index
 */
export function toIndex(row: number, col: number): CellIndex {
  return row * BOARD_SIZE + col;
}

/**
 * Convert flat index to row/col
 */
export function toPosition(index: CellIndex): Position {
  return {
    row: Math.floor(index / BOARD_SIZE),
    col: index % BOARD_SIZE,
  };
}

/**
 * Check if row/col is within board bounds
 */
export function inBounds(row: number, col: number): boolean {
  return row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE;
}

/**
 * Check if index is within board bounds
 */
export function indexInBounds(index: CellIndex): boolean {
  return index >= 0 && index < BOARD_CELLS;
}

/**
 * Get opponent color
 */
export function getOpponent(color: Color): Color {
  return color === BLACK ? WHITE : BLACK;
}

/**
 * Manhattan distance between two positions
 */
export function manhattanDistance(pos1: CellIndex, pos2: CellIndex): number {
  const r1 = Math.floor(pos1 / BOARD_SIZE);
  const c1 = pos1 % BOARD_SIZE;
  const r2 = Math.floor(pos2 / BOARD_SIZE);
  const c2 = pos2 % BOARD_SIZE;
  return Math.abs(r1 - r2) + Math.abs(c1 - c2);
}

/**
 * Chebyshev distance (max of row/col differences)
 */
export function chebyshevDistance(pos1: CellIndex, pos2: CellIndex): number {
  const r1 = Math.floor(pos1 / BOARD_SIZE);
  const c1 = pos1 % BOARD_SIZE;
  const r2 = Math.floor(pos2 / BOARD_SIZE);
  const c2 = pos2 % BOARD_SIZE;
  return Math.max(Math.abs(r1 - r2), Math.abs(c1 - c2));
}

/**
 * Check if a move is a single win move
 */
export function isSingleWinMove(move: Move): move is SingleWinMove {
  return move.action === 'reinforce' && 'pos2' in move && move.pos2 === null;
}

/**
 * Check if two moves are equal
 */
export function movesEqual(m1: Move | null, m2: Move | null): boolean {
  if (!m1 || !m2) return false;
  if (m1.action !== m2.action) return false;
  
  if (m1.action === 'reinforce' && m2.action === 'reinforce') {
    const m1Single = isSingleWinMove(m1);
    const m2Single = isSingleWinMove(m2);
    
    if (m1Single && m2Single) {
      return m1.pos1 === m2.pos1;
    }
    if (m1Single || m2Single) {
      return false; // One is single, one is pair
    }
    
    // Both are pairs - order doesn't matter
    return (m1.pos1 === m2.pos1 && m1.pos2 === m2.pos2) ||
           (m1.pos1 === m2.pos2 && m1.pos2 === m2.pos1);
  }
  
  if (m1.action === 'rift' && m2.action === 'rift') {
    return m1.pos === m2.pos;
  }
  
  return false;
}

/**
 * Convert move to string key for hashing
 */
export function moveToKey(move: Move): string {
  if (move.action === 'reinforce') {
    if (isSingleWinMove(move)) {
      return `w:${move.pos1}`; // Single win move
    }
    const min = Math.min(move.pos1, move.pos2!);
    const max = Math.max(move.pos1, move.pos2!);
    return `r:${min}:${max}`;
  }
  return `x:${move.pos}`;
}

/**
 * Create a reinforce move
 */
export function createReinforceMove(pos1: CellIndex, pos2: CellIndex): ReinforceMove {
  return { action: 'reinforce', pos1, pos2 };
}

/**
 * Create a single-stone winning move
 */
export function createSingleWinMove(pos: CellIndex): SingleWinMove {
  return { action: 'reinforce', pos1: pos, pos2: null, isWinningMove: true };
}

/**
 * Create a rift move
 */
export function createRiftMove(pos: CellIndex): RiftMove {
  return { action: 'rift', pos };
}

/**
 * Convert legacy Position array to Move
 */
export function legacyToMove(action: 'reinforce' | 'rift', positions: Position[]): Move {
  if (action === 'reinforce') {
    return createReinforceMove(
      toIndex(positions[0].row, positions[0].col),
      toIndex(positions[1].row, positions[1].col)
    );
  }
  return createRiftMove(toIndex(positions[0].row, positions[0].col));
}

/**
 * Convert Move to legacy Position array
 */
export function moveToLegacy(move: Move): Position[] {
  if (move.action === 'reinforce') {
    if (isSingleWinMove(move)) {
      return [toPosition(move.pos1)];
    }
    return [toPosition(move.pos1), toPosition(move.pos2!)];
  }
  return [toPosition(move.pos)];
}

/**
 * Check if two positions are colinear (same row, col, or diagonal)
 */
export function areColinear(pos1: CellIndex, pos2: CellIndex): [boolean, [number, number] | null] {
  const r1 = Math.floor(pos1 / BOARD_SIZE);
  const c1 = pos1 % BOARD_SIZE;
  const r2 = Math.floor(pos2 / BOARD_SIZE);
  const c2 = pos2 % BOARD_SIZE;
  
  const dRow = r2 - r1;
  const dCol = c2 - c1;
  
  if (dRow === 0 && dCol === 0) return [false, null];
  if (dRow === 0) return [true, [0, dCol > 0 ? 1 : -1]];
  if (dCol === 0) return [true, [dRow > 0 ? 1 : -1, 0]];
  if (Math.abs(dRow) === Math.abs(dCol)) {
    return [true, [dRow > 0 ? 1 : -1, dCol > 0 ? 1 : -1]];
  }
  return [false, null];
}

/**
 * Get all positions between two colinear positions (exclusive)
 */
export function getPositionsBetween(pos1: CellIndex, pos2: CellIndex): CellIndex[] {
  const [colinear, direction] = areColinear(pos1, pos2);
  if (!colinear || !direction) return [];
  
  const [dRow, dCol] = direction;
  const r1 = Math.floor(pos1 / BOARD_SIZE);
  const c1 = pos1 % BOARD_SIZE;
  const r2 = Math.floor(pos2 / BOARD_SIZE);
  const c2 = pos2 % BOARD_SIZE;
  
  const positions: CellIndex[] = [];
  let row = r1 + dRow;
  let col = c1 + dCol;
  
  while (row !== r2 || col !== c2) {
    positions.push(toIndex(row, col));
    row += dRow;
    col += dCol;
  }
  
  return positions;
}

