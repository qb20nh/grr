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
  gapPositions: CellIndex[]; // Positions of gaps
  extendPositions: CellIndex[]; // Positions that would extend the line
  blockedByOpponent: boolean;
  blockedByEdge: boolean;
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

    while (inBounds(r, c) && board.cells[toIndex(r, c)] === player && count < maxRun) {
      count++;
      r += dr;
      c += dc;
    }

    return { count, endRow: r, endCol: c }; // first non-player (or OOB)
  }

  const left = scanConsecutive(-dRow, -dCol);
  const right = scanConsecutive(dRow, dCol);

  const leftEndIdx = inBounds(left.endRow, left.endCol) ? toIndex(left.endRow, left.endCol) : null;
  const rightEndIdx = inBounds(right.endRow, right.endCol) ? toIndex(right.endRow, right.endCol) : null;

  const baseExtend: CellIndex[] = [];
  const leftOpen = leftEndIdx !== null && isOpenForPlacement(leftEndIdx);
  const rightOpen = rightEndIdx !== null && isOpenForPlacement(rightEndIdx);
  const baseOpenEnds = (leftOpen ? 1 : 0) + (rightOpen ? 1 : 0);

  if (leftOpen && leftEndIdx !== null) baseExtend.push(leftEndIdx);
  if (rightOpen && rightEndIdx !== null) baseExtend.push(rightEndIdx);

  const baseInfo: LineInfo = {
    count: left.count + 1 + right.count,
    openEnds: baseOpenEnds,
    gaps: 0,
    gapPositions: [],
    extendPositions: baseExtend,
    blockedByOpponent: false,
    blockedByEdge: false,
  };

  // Gap variants: allow a single empty (gap) followed by more stones.
  const variants: LineInfo[] = [baseInfo];

  // Right-gap: ... [stones] _ [stones]
  if (rightEndIdx !== null && isOpenForPlacement(rightEndIdx)) {
    const gapRow = right.endRow;
    const gapCol = right.endCol;
    const afterGapRow = gapRow + dRow;
    const afterGapCol = gapCol + dCol;

    if (inBounds(afterGapRow, afterGapCol) && board.cells[toIndex(afterGapRow, afterGapCol)] === player) {
      // Count stones after the gap
      let afterCount = 1;
      let r = afterGapRow + dRow;
      let c = afterGapCol + dCol;
      while (inBounds(r, c) && board.cells[toIndex(r, c)] === player && afterCount < maxRun) {
        afterCount++;
        r += dRow;
        c += dCol;
      }

      const farEndIdx = inBounds(r, c) ? toIndex(r, c) : null;
      const extend: CellIndex[] = [];
      if (leftOpen && leftEndIdx !== null) extend.push(leftEndIdx);
      if (farEndIdx !== null && isOpenForPlacement(farEndIdx) && farEndIdx !== leftEndIdx) {
        extend.push(farEndIdx);
      }

      variants.push({
        count: left.count + 1 + right.count + afterCount,
        openEnds:
          (leftOpen ? 1 : 0) +
          (farEndIdx !== null && isOpenForPlacement(farEndIdx) ? 1 : 0),
        gaps: 1,
        gapPositions: [rightEndIdx],
        extendPositions: extend,
        blockedByOpponent: false,
        blockedByEdge: false,
      });
    }
  }

  // Left-gap: [stones] _ [stones] ...
  if (leftEndIdx !== null && isOpenForPlacement(leftEndIdx)) {
    const gapRow = left.endRow;
    const gapCol = left.endCol;
    const afterGapRow = gapRow - dRow;
    const afterGapCol = gapCol - dCol;

    if (inBounds(afterGapRow, afterGapCol) && board.cells[toIndex(afterGapRow, afterGapCol)] === player) {
      let afterCount = 1;
      let r = afterGapRow - dRow;
      let c = afterGapCol - dCol;
      while (inBounds(r, c) && board.cells[toIndex(r, c)] === player && afterCount < maxRun) {
        afterCount++;
        r -= dRow;
        c -= dCol;
      }

      const farEndIdx = inBounds(r, c) ? toIndex(r, c) : null;
      const extend: CellIndex[] = [];
      if (farEndIdx !== null && isOpenForPlacement(farEndIdx)) extend.push(farEndIdx);
      if (rightOpen && rightEndIdx !== null && rightEndIdx !== farEndIdx) extend.push(rightEndIdx);

      variants.push({
        count: left.count + 1 + right.count + afterCount,
        openEnds:
          (farEndIdx !== null && isOpenForPlacement(farEndIdx) ? 1 : 0) +
          (rightOpen ? 1 : 0),
        gaps: 1,
        gapPositions: [leftEndIdx],
        extendPositions: extend,
        blockedByOpponent: false,
        blockedByEdge: false,
      });
    }
  }

  // Choose the variant that yields the best pattern classification.
  const rank: Record<string, number> = {
    FIVE: 9,
    OPEN_FOUR: 8,
    GAP_FOUR: 7,
    HALF_FOUR: 6,
    OPEN_THREE: 5,
    GAP_THREE: 4,
    HALF_THREE: 3,
    OPEN_TWO: 2,
    HALF_TWO: 1,
  };

  let best = variants[0];
  let bestRank = rank[String(classifyLine(best))] ?? 0;

  for (let i = 1; i < variants.length; i++) {
    const v = variants[i];
    const vRank = rank[String(classifyLine(v))] ?? 0;
    if (vRank > bestRank) {
      best = v;
      bestRank = vRank;
    } else if (vRank === bestRank && v.count > best.count) {
      // Tie-breaker: prefer higher stone count (helps move ordering heuristics)
      best = v;
    }
  }

  return best;
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
  
  // Track which lines we've already counted.
  // Use numeric keys to avoid string allocations in this hot path.
  const counted = new Set<number>();
  
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
        info.gapPositions.length > 0
      ) {
        // Gap-key namespace starts after contiguous line keys.
        lineKey = BOARD_CELLS * 4 + info.gapPositions[0] * 4 + dir;
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
      if (counted.has(lineKey)) continue;
      counted.add(lineKey);

      counts[pattern as keyof PatternCounts]++;
    }
  }
  
  return counts;
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

