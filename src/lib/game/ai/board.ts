/**
 * Board representation and operations
 * Uses Uint8Array for cache-friendly, fast access
 */

import { BOARD_SIZE, BOARD_CELLS, DIRECTIONS } from './constants';
import type { Board, CellIndex, CellValue, Color, Move, UndoInfo } from './types';
import { EMPTY, BLACK, WHITE } from './types';
import { toIndex, toPosition, inBounds, getOpponent, areColinear, getPositionsBetween, isSingleWinMove } from './utils';
import { updateHash, updateKoHash, computeFullHash } from './zobrist';

/**
 * Create an empty board
 */
export function createBoard(): Board {
  return {
    cells: new Uint8Array(BOARD_CELLS),
    blackCount: 0,
    whiteCount: 0,
    hash: 0n,
    koPosition: null,
  };
}

/**
 * Create a board from a 2D array (for compatibility with existing code)
 */
export function boardFrom2D(grid: (string | null)[][], koPosition: number | null = null): Board {
  const cells = new Uint8Array(BOARD_CELLS);
  let blackCount = 0;
  let whiteCount = 0;
  
  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      const idx = toIndex(row, col);
      const cell = grid[row]?.[col];
      if (cell === 'black') {
        cells[idx] = BLACK;
        blackCount++;
      } else if (cell === 'white') {
        cells[idx] = WHITE;
        whiteCount++;
      }
    }
  }
  
  const board: Board = {
    cells,
    blackCount,
    whiteCount,
    hash: 0n,
    koPosition,
  };
  
  board.hash = computeFullHash(board);
  return board;
}

/**
 * Convert board to 2D array (for compatibility)
 */
export function boardTo2D(board: Board): (string | null)[][] {
  const grid: (string | null)[][] = [];
  
  for (let row = 0; row < BOARD_SIZE; row++) {
    const rowArr: (string | null)[] = [];
    for (let col = 0; col < BOARD_SIZE; col++) {
      const cell = board.cells[toIndex(row, col)];
      if (cell === BLACK) rowArr.push('black');
      else if (cell === WHITE) rowArr.push('white');
      else rowArr.push(null);
    }
    grid.push(rowArr);
  }
  
  return grid;
}

/**
 * Clone a board
 */
export function cloneBoard(board: Board): Board {
  return {
    cells: new Uint8Array(board.cells),
    blackCount: board.blackCount,
    whiteCount: board.whiteCount,
    hash: board.hash,
    koPosition: board.koPosition,
  };
}

/**
 * Get cell value at index
 */
export function getCell(board: Board, index: CellIndex): CellValue {
  return board.cells[index] as CellValue;
}

/**
 * Get cell value at row/col
 */
export function getCellAt(board: Board, row: number, col: number): CellValue {
  return board.cells[toIndex(row, col)] as CellValue;
}

/**
 * Check if a position is empty
 */
export function isEmpty(board: Board, index: CellIndex): boolean {
  return board.cells[index] === EMPTY;
}

/**
 * Check if a position is valid for placement
 */
export function isValidPlacement(board: Board, index: CellIndex): boolean {
  if (index < 0 || index >= BOARD_CELLS) return false;
  if (board.cells[index] !== EMPTY) return false;
  if (board.koPosition === index) return false;
  return true;
}

/**
 * Check colinearity constraint for reinforce move
 * Two stones cannot be on same line unless opponent stone is between them
 */
export function checkColinearityConstraint(
  board: Board,
  pos1: CellIndex,
  pos2: CellIndex,
  player: Color
): boolean {
  const [colinear, direction] = areColinear(pos1, pos2);
  if (!colinear || !direction) return true; // Not colinear = OK
  
  const opponent = getOpponent(player);
  const between = getPositionsBetween(pos1, pos2);
  
  // Must have at least one opponent stone between
  for (const pos of between) {
    if (board.cells[pos] === opponent) {
      return true; // Shield exception applies
    }
  }
  
  return false; // Colinear without shield = invalid
}

/**
 * Validate a reinforce move
 */
export function validateReinforce(
  board: Board,
  pos1: CellIndex,
  pos2: CellIndex,
  player: Color
): boolean {
  if (!isValidPlacement(board, pos1)) return false;
  if (!isValidPlacement(board, pos2)) return false;
  if (pos1 === pos2) return false;
  return checkColinearityConstraint(board, pos1, pos2, player);
}

/**
 * Validate a rift move
 */
export function validateRift(board: Board, pos: CellIndex, player: Color): boolean {
  if (pos < 0 || pos >= BOARD_CELLS) return false;
  const opponent = getOpponent(player);
  return board.cells[pos] === opponent;
}

/**
 * Place a stone on the board (mutates board)
 */
export function placeStone(board: Board, index: CellIndex, color: Color): void {
  board.cells[index] = color;
  board.hash = updateHash(board.hash, index, color);
  if (color === BLACK) board.blackCount++;
  else board.whiteCount++;
}

/**
 * Remove a stone from the board (mutates board)
 */
export function removeStone(board: Board, index: CellIndex): CellValue {
  const prev = board.cells[index] as CellValue;
  if (prev !== EMPTY) {
    board.hash = updateHash(board.hash, index, prev as Color);
    if (prev === BLACK) board.blackCount--;
    else board.whiteCount--;
  }
  board.cells[index] = EMPTY;
  return prev;
}

/**
 * Make a move on the board, return undo info
 */
export function makeMove(board: Board, move: Move, player: Color): UndoInfo {
  const prevHash = board.hash;
  const prevKo = board.koPosition;
  const nextKo = move.action === 'rift' ? move.pos : null;

  // Ko position is part of the game state; keep hash in sync.
  if (prevKo !== nextKo) {
    board.hash = updateKoHash(board.hash, prevKo, nextKo);
    board.koPosition = nextKo;
  }
  
  if (move.action === 'reinforce') {
    placeStone(board, move.pos1, player);
    // Check if it's a single win move (pos2 is null)
    if (!isSingleWinMove(move)) {
      placeStone(board, move.pos2, player);
    }
    return { move, prevHash, prevKo, capturedStone: undefined };
  } else {
    const captured = removeStone(board, move.pos);
    return { move, prevHash, prevKo, capturedStone: captured };
  }
}

/**
 * Unmake a move, restoring previous state
 */
export function unmakeMove(board: Board, undoInfo: UndoInfo, player: Color): void {
  const { move, prevHash, prevKo, capturedStone } = undoInfo;
  
  if (move.action === 'reinforce') {
    removeStone(board, move.pos1);
    // Check if it's a single win move (pos2 is null)
    if (!isSingleWinMove(move)) {
      removeStone(board, move.pos2);
    }
  } else {
    // Restore captured stone
    if (capturedStone !== undefined && capturedStone !== EMPTY) {
      placeStone(board, move.pos, capturedStone as Color);
    }
  }
  
  board.hash = prevHash;
  board.koPosition = prevKo;
}

/**
 * Check if exactly 5 in a row exists at position
 */
export function checkWinAt(board: Board, index: CellIndex, color: Color): boolean {
  const row = Math.floor(index / BOARD_SIZE);
  const col = index % BOARD_SIZE;
  
  for (const [dRow, dCol] of DIRECTIONS) {
    let count = 1;
    
    // Forward
    let r = row + dRow;
    let c = col + dCol;
    while (inBounds(r, c) && board.cells[toIndex(r, c)] === color) {
      count++;
      r += dRow;
      c += dCol;
    }
    
    // Backward
    r = row - dRow;
    c = col - dCol;
    while (inBounds(r, c) && board.cells[toIndex(r, c)] === color) {
      count++;
      r -= dRow;
      c -= dCol;
    }
    
    if (count === 5) return true; // Exactly 5 (not overline)
  }
  
  return false;
}

/**
 * Determine if the just-applied move ended the game, returning the winner color.
 *
 * Important: for Rift, the winner can be the *removed* color due to the exact-5 rule
 * (trimming an overline down to exactly 5). We only need to inspect lines passing
 * through the rifted position.
 */
export function getWinnerAfterMove(board: Board, move: Move, mover: Color): Color | null {
  if (move.action === 'reinforce') {
    if (checkWinAt(board, move.pos1, mover)) return mover;
    if (!isSingleWinMove(move) && checkWinAt(board, move.pos2, mover)) return mover;
    return null;
  }

  // Rift: removing opponent stone can create an exact-5 for the removed color.
  const removedColor = getOpponent(mover);
  const riftPos = move.pos;
  const row = Math.floor(riftPos / BOARD_SIZE);
  const col = riftPos % BOARD_SIZE;

  for (const [dRow, dCol] of DIRECTIONS) {
    // Count contiguous stones starting adjacent to the removed cell in each direction.
    let forward = 0;
    let r = row + dRow;
    let c = col + dCol;
    while (inBounds(r, c) && board.cells[toIndex(r, c)] === removedColor) {
      forward++;
      r += dRow;
      c += dCol;
    }

    let backward = 0;
    r = row - dRow;
    c = col - dCol;
    while (inBounds(r, c) && board.cells[toIndex(r, c)] === removedColor) {
      backward++;
      r -= dRow;
      c -= dCol;
    }

    // The removed cell splits the line; either side segment could now be exactly 5.
    if (forward === 5 || backward === 5) return removedColor;
  }

  return null;
}

/**
 * Check if player has won (any 5 in a row)
 */
export function hasWon(board: Board, color: Color): boolean {
  for (let i = 0; i < BOARD_CELLS; i++) {
    if (board.cells[i] === color && checkWinAt(board, i, color)) {
      return true;
    }
  }
  return false;
}

/**
 * Get total stone count
 */
export function getTotalStones(board: Board): number {
  return board.blackCount + board.whiteCount;
}

/**
 * Check if board is empty
 */
export function isBoardEmpty(board: Board): boolean {
  return board.blackCount === 0 && board.whiteCount === 0;
}

/**
 * Get all positions of a color
 */
export function getStonePositions(board: Board, color: Color): CellIndex[] {
  const positions: CellIndex[] = [];
  for (let i = 0; i < BOARD_CELLS; i++) {
    if (board.cells[i] === color) {
      positions.push(i);
    }
  }
  return positions;
}

/**
 * Get all empty positions
 */
export function getEmptyPositions(board: Board): CellIndex[] {
  const positions: CellIndex[] = [];
  for (let i = 0; i < BOARD_CELLS; i++) {
    if (board.cells[i] === EMPTY && board.koPosition !== i) {
      positions.push(i);
    }
  }
  return positions;
}

