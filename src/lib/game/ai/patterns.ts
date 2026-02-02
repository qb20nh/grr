/**
 * Pattern Detection for Gomoku Rift
 * Identifies lines, threats, and tactical patterns
 */

import { BOARD_SIZE, BOARD_CELLS, DIRECTIONS } from './constants';
import type { Board, CellIndex, Color, PatternType, PatternCounts } from './types';
import { EMPTY } from './types';
import { toIndex, inBounds } from './utils';

/**
 * Line information from scanning in one direction
 */
export interface LineInfo {
  count: number;          // Consecutive stones of player
  openEnds: number;       // 0, 1, or 2 open ends
  gaps: number;           // Number of gaps within potential 5
  /**
   * For GAP_* patterns this is the single gap cell (0..224). Otherwise -1.
   * (We keep it scalar to avoid per-call array allocations in this hot path.)
   */
  gapPos: CellIndex; // -1 when none
  /** Number of extend squares (0..2). */
  extendCount: number;
  extend1: CellIndex; // -1 when absent
  extend2: CellIndex; // -1 when absent
}

const NO_POS: CellIndex = -1;

function stepsToEdge(row: number, col: number, dr: number, dc: number): number {
  // How many steps can we take from (row,col) in direction (dr,dc) before leaving the board?
  // (dr,dc) are always in {-1,0,1} in this engine.
  const rowSteps = dr === 0 ? 99 : dr > 0 ? (BOARD_SIZE - 1 - row) : row;
  const colSteps = dc === 0 ? 99 : dc > 0 ? (BOARD_SIZE - 1 - col) : col;
  return Math.min(rowSteps, colSteps);
}

function maxInBoundsLineLength(row: number, col: number, dr: number, dc: number): number {
  // Total number of in-bounds cells on the full line through (row,col) in direction (dr,dc).
  // If this is < 5, an exact-5 score is impossible on this line, regardless of play.
  return 1 + stepsToEdge(row, col, dr, dc) + stepsToEdge(row, col, -dr, -dc);
}

function rankFor(count: number, openEnds: number, gaps: number): number {
  // Exactly 5 = win
  if (count === 5 && gaps === 0) return 9; // FIVE
  // Overline (6+) is not a win
  if (count > 5) return 0;

  if (count === 4) {
    if (gaps === 0) {
      if (openEnds === 2) return 8; // OPEN_FOUR
      if (openEnds === 1) return 6; // HALF_FOUR
    } else if (gaps === 1) {
      return 7; // GAP_FOUR
    }
  }

  if (count === 3) {
    if (gaps === 0) {
      if (openEnds === 2) return 5; // OPEN_THREE
      if (openEnds === 1) return 3; // HALF_THREE
    } else if (gaps === 1 && openEnds >= 1) {
      return 4; // GAP_THREE
    }
  }

  if (count === 2 && gaps === 0) {
    if (openEnds === 2) return 2; // OPEN_TWO
    if (openEnds === 1) return 1; // HALF_TWO
  }

  return 0;
}

/**
 * Scan a line from a position in both directions
 */
export function scanLine(
  board: Board,
  pos: CellIndex,
  dirIdx: number,
  player: Color,
  ignoreKo: boolean = false
): LineInfo {
  const [dRow, dCol] = DIRECTIONS[dirIdx];
  const startRow = Math.floor(pos / BOARD_SIZE);
  const startCol = pos % BOARD_SIZE;

  // If the board edge makes an exact-5 impossible on this line (e.g. short diagonals near corners),
  // treat it as pattern-less. This prevents the eval from chasing "dead" lines that can never score.
  if (maxInBoundsLineLength(startRow, startCol, dRow, dCol) < 5) {
    return {
      count: 1,
      openEnds: 0,
      gaps: 0,
      gapPos: NO_POS,
      extendCount: 0,
      extend1: NO_POS,
      extend2: NO_POS,
    };
  }

  const isOpenForPlacement = (idx: CellIndex): boolean =>
    board.cells[idx] === EMPTY && (ignoreKo || board.koPosition !== idx);

  const maxRun = 6; // enough to detect overline/long lines cheaply

  // Scan consecutive stones in a direction until blocked or maxRun reached.
  function scanConsecutive(
    dr: number,
    dc: number
  ): { count: number; endRow: number; endCol: number } {
    let count = 0;
    let r = startRow + dr;
    let c = startCol + dc;

    while (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE && board.cells[r * BOARD_SIZE + c] === player && count < maxRun) {
      count++;
      r += dr;
      c += dc;
    }

    return { count, endRow: r, endCol: c }; // first non-player (or OOB)
  }

  const left = scanConsecutive(-dRow, -dCol);
  const right = scanConsecutive(dRow, dCol);

  const leftEndIdx = inBounds(left.endRow, left.endCol) ? toIndex(left.endRow, left.endCol) : NO_POS;
  const rightEndIdx = inBounds(right.endRow, right.endCol) ? toIndex(right.endRow, right.endCol) : NO_POS;

  const leftOpen = leftEndIdx !== NO_POS && isOpenForPlacement(leftEndIdx);
  const rightOpen = rightEndIdx !== NO_POS && isOpenForPlacement(rightEndIdx);

  // Base (no gap) variant.
  let bestCount = left.count + 1 + right.count;
  let bestOpenEnds = (leftOpen ? 1 : 0) + (rightOpen ? 1 : 0);
  let bestGaps = 0;
  let bestGapPos: CellIndex = NO_POS;
  let bestExtendCount = 0;
  let bestExtend1: CellIndex = NO_POS;
  let bestExtend2: CellIndex = NO_POS;

  if (leftOpen) {
    bestExtend1 = leftEndIdx;
    bestExtendCount = 1;
  }
  if (rightOpen) {
    if (bestExtendCount === 0) {
      bestExtend1 = rightEndIdx;
      bestExtendCount = 1;
    } else if (rightEndIdx !== bestExtend1) {
      bestExtend2 = rightEndIdx;
      bestExtendCount = 2;
    }
  }

  let bestRank = rankFor(bestCount, bestOpenEnds, bestGaps);

  // Right-gap: ... [stones] _ [stones]
  if (rightOpen) {
    const gapRow = right.endRow;
    const gapCol = right.endCol;
    const afterGapRow = gapRow + dRow;
    const afterGapCol = gapCol + dCol;

    if (inBounds(afterGapRow, afterGapCol) && board.cells[afterGapRow * BOARD_SIZE + afterGapCol] === player) {
      // Count stones after the gap
      let afterCount = 1;
      let r = afterGapRow + dRow;
      let c = afterGapCol + dCol;
      while (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE && board.cells[r * BOARD_SIZE + c] === player && afterCount < maxRun) {
        afterCount++;
        r += dRow;
        c += dCol;
      }

      const farEndIdx = inBounds(r, c) ? toIndex(r, c) : NO_POS;
      const farOpen = farEndIdx !== NO_POS && isOpenForPlacement(farEndIdx);

      const vCount = bestCount + afterCount;
      const vOpenEnds = (leftOpen ? 1 : 0) + (farOpen ? 1 : 0);
      const vRank = rankFor(vCount, vOpenEnds, 1);

      if (vRank > bestRank || (vRank === bestRank && vCount > bestCount)) {
        bestRank = vRank;
        bestCount = vCount;
        bestOpenEnds = vOpenEnds;
        bestGaps = 1;
        bestGapPos = rightEndIdx;
        bestExtendCount = 0;
        bestExtend1 = NO_POS;
        bestExtend2 = NO_POS;

        if (leftOpen) {
          bestExtend1 = leftEndIdx;
          bestExtendCount = 1;
        }
        if (farOpen) {
          if (bestExtendCount === 0) {
            bestExtend1 = farEndIdx;
            bestExtendCount = 1;
          } else if (farEndIdx !== bestExtend1) {
            bestExtend2 = farEndIdx;
            bestExtendCount = 2;
          }
        }
      }
    }
  }

  // Left-gap: [stones] _ [stones] ...
  if (leftOpen) {
    const gapRow = left.endRow;
    const gapCol = left.endCol;
    const afterGapRow = gapRow - dRow;
    const afterGapCol = gapCol - dCol;

    if (inBounds(afterGapRow, afterGapCol) && board.cells[afterGapRow * BOARD_SIZE + afterGapCol] === player) {
      let afterCount = 1;
      let r = afterGapRow - dRow;
      let c = afterGapCol - dCol;
      while (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE && board.cells[r * BOARD_SIZE + c] === player && afterCount < maxRun) {
        afterCount++;
        r -= dRow;
        c -= dCol;
      }

      const farEndIdx = inBounds(r, c) ? toIndex(r, c) : NO_POS;
      const farOpen = farEndIdx !== NO_POS && isOpenForPlacement(farEndIdx);

      const vCount = bestCount + afterCount;
      const vOpenEnds = (farOpen ? 1 : 0) + (rightOpen ? 1 : 0);
      const vRank = rankFor(vCount, vOpenEnds, 1);

      if (vRank > bestRank || (vRank === bestRank && vCount > bestCount)) {
        bestRank = vRank;
        bestCount = vCount;
        bestOpenEnds = vOpenEnds;
        bestGaps = 1;
        bestGapPos = leftEndIdx;
        bestExtendCount = 0;
        bestExtend1 = NO_POS;
        bestExtend2 = NO_POS;

        if (farOpen) {
          bestExtend1 = farEndIdx;
          bestExtendCount = 1;
        }
        if (rightOpen && rightEndIdx !== NO_POS) {
          if (bestExtendCount === 0) {
            bestExtend1 = rightEndIdx;
            bestExtendCount = 1;
          } else if (rightEndIdx !== bestExtend1) {
            bestExtend2 = rightEndIdx;
            bestExtendCount = 2;
          }
        }
      }
    }
  }

  return {
    count: bestCount,
    openEnds: bestOpenEnds,
    gaps: bestGaps,
    gapPos: bestGapPos,
    extendCount: bestExtendCount,
    extend1: bestExtend1,
    extend2: bestExtend2,
  };
}

/**
 * Classify a line into a pattern type
 */
export function classifyLine(info: LineInfo): PatternType | null {
  const { count, openEnds, gaps } = info;
  
  // Exactly 5 = win
  if (count === 5 && gaps === 0) {
    return 'FIVE' as PatternType;
  }
  
  // Overline (6+) is not a win
  if (count > 5) {
    return null;
  }
  
  // Four patterns
  if (count === 4) {
    if (gaps === 0) {
      if (openEnds === 2) return 'OPEN_FOUR' as PatternType;
      if (openEnds === 1) return 'HALF_FOUR' as PatternType;
    } else if (gaps === 1) {
      return 'GAP_FOUR' as PatternType;
    }
  }
  
  // Three patterns
  if (count === 3) {
    if (gaps === 0) {
      if (openEnds === 2) return 'OPEN_THREE' as PatternType;
      if (openEnds === 1) return 'HALF_THREE' as PatternType;
    } else if (gaps === 1 && openEnds >= 1) {
      return 'GAP_THREE' as PatternType;
    }
  }
  
  // Two patterns
  if (count === 2 && gaps === 0) {
    if (openEnds === 2) return 'OPEN_TWO' as PatternType;
    if (openEnds === 1) return 'HALF_TWO' as PatternType;
  }
  
  return null;
}

/**
 * Count all patterns for a player on the board
 */
export function countPatterns(board: Board, player: Color): PatternCounts {
  const counts: PatternCounts = {
    FIVE: 0,
    OPEN_FOUR: 0,
    HALF_FOUR: 0,
    OPEN_THREE: 0,
    HALF_THREE: 0,
    OPEN_TWO: 0,
    HALF_TWO: 0,
    GAP_FOUR: 0,
    GAP_THREE: 0,
  };
  
  // Track which lines we've already counted (allocation-free stamp mask).
  const stamp = nextCountedStamp();
  
  for (let pos = 0; pos < BOARD_CELLS; pos++) {
    if (board.cells[pos] !== player) continue;
    
    for (let dir = 0; dir < 4; dir++) {
      const info = scanLine(board, pos, dir, player);
      if (info.count < 2) continue;

      const pattern = classifyLine(info);
      if (pattern === null) continue;
      
      // Generate key based on line extent
      const [dRow, dCol] = DIRECTIONS[dir];
      const row = Math.floor(pos / BOARD_SIZE);
      const col = pos % BOARD_SIZE;

      // Gap lines (e.g., XX_XX) are split into two segments, so use the gap cell as the key.
      // This prevents double-counting from each side of the gap.
      let lineKey: number;
      if (
        (pattern === 'GAP_FOUR' || pattern === 'GAP_THREE') &&
        info.gaps === 1 &&
        info.gapPos !== NO_POS
      ) {
        // Gap-key namespace starts after contiguous line keys.
        lineKey = BOARD_CELLS * 4 + info.gapPos * 4 + dir;
      } else {
        // Find start of contiguous line
        let startR = row, startC = col;
        while (
          inBounds(startR - dRow, startC - dCol) &&
          board.cells[toIndex(startR - dRow, startC - dCol)] === player
        ) {
          startR -= dRow;
          startC -= dCol;
        }
        const startIdx = toIndex(startR, startC);
        lineKey = startIdx * 4 + dir;
      }
      if (COUNTED_LINES[lineKey] === stamp) continue;
      COUNTED_LINES[lineKey] = stamp;

      counts[pattern as keyof PatternCounts]++;
    }
  }
  
  return counts;
}

// ---- countPatterns de-dup stamp (0..(BOARD_CELLS*8-1)) ----
const COUNTED_LINES = new Uint32Array(BOARD_CELLS * 8);
let countedStamp = 1;
function nextCountedStamp(): number {
  countedStamp = (countedStamp + 1) >>> 0;
  if (countedStamp === 0) {
    COUNTED_LINES.fill(0);
    countedStamp = 1;
  }
  return countedStamp;
}

/**
 * Get patterns at a specific position (for move evaluation)
 */
export function getPatternsAtPosition(
  board: Board,
  pos: CellIndex,
  player: Color
): PatternType[] {
  const patterns: PatternType[] = [];
  
  for (let dir = 0; dir < 4; dir++) {
    const info = scanLine(board, pos, dir, player);
    const pattern = classifyLine(info);
    if (pattern !== null) {
      patterns.push(pattern);
    }
  }
  
  return patterns;
}

/**
 * Check if placing a stone creates a specific pattern or better
 */
export function wouldCreatePattern(
  board: Board,
  pos: CellIndex,
  player: Color,
  targetPattern: PatternType
): boolean {
  // Temporarily place stone
  const original = board.cells[pos];
  board.cells[pos] = player;
  
  const patterns = getPatternsAtPosition(board, pos, player);
  
  // Restore
  board.cells[pos] = original;
  
  // Check if any pattern matches or is better
  const patternRank: Record<PatternType, number> = {
    FIVE: 10,
    OPEN_FOUR: 9,
    GAP_FOUR: 8,
    HALF_FOUR: 7,
    OPEN_THREE: 6,
    GAP_THREE: 5,
    HALF_THREE: 4,
    OPEN_TWO: 3,
    HALF_TWO: 2,
  };
  
  const targetRank = patternRank[targetPattern];
  return patterns.some(p => patternRank[p] >= targetRank);
}

/**
 * Count how many threats (patterns that need response) a position creates
 */
export function countThreatsCreated(
  board: Board,
  pos: CellIndex,
  player: Color
): number {
  // Temporarily place stone
  const original = board.cells[pos];
  board.cells[pos] = player;
  
  let threats = 0;
  
  for (let dir = 0; dir < 4; dir++) {
    const info = scanLine(board, pos, dir, player);
    const pattern = classifyLine(info);
    
    // Threats are patterns that opponent must respond to
    if (pattern === 'FIVE' as PatternType ||
        pattern === 'OPEN_FOUR' as PatternType ||
        pattern === 'GAP_FOUR' as PatternType ||
        pattern === 'HALF_FOUR' as PatternType ||
        pattern === 'OPEN_THREE' as PatternType) {
      threats++;
    }
  }
  
  // Restore
  board.cells[pos] = original;
  
  return threats;
}

/**
 * Get the best pattern a position contributes to
 */
export function getBestPattern(
  board: Board,
  pos: CellIndex,
  player: Color
): PatternType | null {
  const patterns = getPatternsAtPosition(board, pos, player);
  
  if (patterns.length === 0) return null;
  
  const patternRank: Record<PatternType, number> = {
    FIVE: 10,
    OPEN_FOUR: 9,
    GAP_FOUR: 8,
    HALF_FOUR: 7,
    OPEN_THREE: 6,
    GAP_THREE: 5,
    HALF_THREE: 4,
    OPEN_TWO: 3,
    HALF_TWO: 2,
  };
  
  let best: PatternType | null = null;
  let bestRank = -1;
  
  for (const p of patterns) {
    const rank = patternRank[p];
    if (rank > bestRank) {
      bestRank = rank;
      best = p;
    }
  }
  
  return best;
}

/**
 * Quick check: does player have an immediate winning move?
 */
export function hasImmediateWin(board: Board, player: Color): CellIndex | null {
  for (let pos = 0; pos < BOARD_CELLS; pos++) {
    if (board.cells[pos] !== EMPTY) continue;
    if (board.koPosition === pos) continue;
    
    // Temporarily place
    board.cells[pos] = player;
    
    // Check all directions
    let wins = false;
    for (let dir = 0; dir < 4; dir++) {
      const info = scanLine(board, pos, dir, player);
      if (info.count === 5 && info.gaps === 0) {
        wins = true;
        break;
      }
    }
    
    // Restore
    board.cells[pos] = EMPTY;
    
    if (wins) return pos;
  }
  
  return null;
}

