import type { Stone, Position, PlayerColor } from './types';
import { BOARD_SIZE } from './types';

const DIRECTIONS: [number, number][] = [
  [0, 1],   // horizontal
  [1, 0],   // vertical
  [1, 1],   // diagonal down-right
  [1, -1],  // diagonal down-left
];

/**
 * Counts consecutive stones of a given color starting from a position in a direction.
 * Does not include the starting position in the count.
 */
function countInDirection(
  board: Stone[][],
  startRow: number,
  startCol: number,
  dRow: number,
  dCol: number,
  color: PlayerColor
): number {
  let count = 0;
  let row = startRow + dRow;
  let col = startCol + dCol;

  while (
    row >= 0 && row < BOARD_SIZE &&
    col >= 0 && col < BOARD_SIZE &&
    board[row][col] === color
  ) {
    count++;
    row += dRow;
    col += dCol;
  }

  return count;
}

/**
 * Checks if placing a stone at the given position creates exactly 5 in a row.
 * Returns true only for exactly 5 (not 6 or more - overline rule).
 */
export function checkWinAtPosition(
  board: Stone[][],
  pos: Position,
  color: PlayerColor
): boolean {
  for (const [dRow, dCol] of DIRECTIONS) {
    const countForward = countInDirection(board, pos.row, pos.col, dRow, dCol, color);
    const countBackward = countInDirection(board, pos.row, pos.col, -dRow, -dCol, color);
    const total = countForward + countBackward + 1; // +1 for the stone at pos

    if (total === 5) {
      return true;
    }
  }

  return false;
}

/**
 * Checks if any of the given positions result in a win.
 */
export function checkWinForPositions(
  board: Stone[][],
  positions: Position[],
  color: PlayerColor
): boolean {
  return positions.some(pos => checkWinAtPosition(board, pos, color));
}

/**
 * Scans the entire board for a winning line of exactly 5.
 * Used after rift actions which might expose a winning line.
 */
export function scanBoardForWin(board: Stone[][]): PlayerColor | null {
  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      const stone = board[row][col];
      if (stone && checkWinAtPosition(board, { row, col }, stone)) {
        return stone;
      }
    }
  }
  return null;
}

/**
 * Gets the winning line positions if there's a win at the given position.
 */
export function getWinningLine(
  board: Stone[][],
  pos: Position,
  color: PlayerColor
): Position[] | null {
  for (const [dRow, dCol] of DIRECTIONS) {
    const line: Position[] = [pos];
    
    // Count forward
    let row = pos.row + dRow;
    let col = pos.col + dCol;
    while (
      row >= 0 && row < BOARD_SIZE &&
      col >= 0 && col < BOARD_SIZE &&
      board[row][col] === color
    ) {
      line.push({ row, col });
      row += dRow;
      col += dCol;
    }

    // Count backward
    row = pos.row - dRow;
    col = pos.col - dCol;
    while (
      row >= 0 && row < BOARD_SIZE &&
      col >= 0 && col < BOARD_SIZE &&
      board[row][col] === color
    ) {
      line.unshift({ row, col });
      row -= dRow;
      col -= dCol;
    }

    if (line.length === 5) {
      return line;
    }
  }

  return null;
}

