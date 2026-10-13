/**
 * Pattern Detection for Gomoku Rift
 * Identifies lines, threats, and tactical patterns
 */

import { BOARD_SIZE, BOARD_CELLS, DIRECTIONS } from './constants';
import type { Board, CellIndex, Color, PatternType, PatternCounts } from './types';
import { EMPTY } from './types';

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

// Board geometry is immutable; avoid row/column division, bounds checks, and
// two temporary scan objects on every pattern lookup.
export const FORWARD_STEPS = new Uint8Array(BOARD_CELLS * 4);
export const BACKWARD_STEPS = new Uint8Array(BOARD_CELLS * 4);
export const LINE_OFFSETS = DIRECTIONS.map(([dr, dc]) => dr * BOARD_SIZE + dc);
for (let pos = 0; pos < BOARD_CELLS; pos++) {
  const row = Math.floor(pos / BOARD_SIZE), col = pos % BOARD_SIZE;
  for (let dir = 0; dir < 4; dir++) {
    const [dr, dc] = DIRECTIONS[dir];
    const steps = (r: number, c: number): number => Math.min(
      r === 0 ? BOARD_SIZE : r > 0 ? BOARD_SIZE - 1 - row : row,
      c === 0 ? BOARD_SIZE : c > 0 ? BOARD_SIZE - 1 - col : col
    );
    FORWARD_STEPS[pos * 4 + dir] = steps(dr, dc);
    BACKWARD_STEPS[pos * 4 + dir] = steps(-dr, -dc);
  }
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

const PATTERN_BY_RANK: readonly (PatternType | null)[] = [
  null, 'HALF_TWO', 'OPEN_TWO', 'HALF_THREE', 'GAP_THREE',
  'OPEN_THREE', 'HALF_FOUR', 'GAP_FOUR', 'OPEN_FOUR', 'FIVE',
] as (PatternType | null)[];

/** Pattern-only scan for move scoring and forks, without allocating LineInfo. */
export function patternAt(
  board: Board, pos: CellIndex, dir: number, player: Color, ignoreKo = false
): PatternType | null {
  const geometry = pos * 4 + dir;
  const forward = FORWARD_STEPS[geometry], backward = BACKWARD_STEPS[geometry];
  if (1 + forward + backward < 5) return null;
  const offset = LINE_OFFSETS[dir], cells = board.cells;
  const ko = ignoreKo ? -1 : board.koPosition;
  let left = 0, right = 0;
  while (left < backward && left < 6 && cells[pos - (left + 1) * offset] === player) left++;
  while (right < forward && right < 6 && cells[pos + (right + 1) * offset] === player) right++;
  const count = left + 1 + right;
  if (count >= 5) return count === 5 ? PATTERN_BY_RANK[9] : null;
  const leftEnd = pos - (left + 1) * offset, rightEnd = pos + (right + 1) * offset;
  const leftOpen = left < backward && cells[leftEnd] === EMPTY && leftEnd !== ko;
  const rightOpen = right < forward && cells[rightEnd] === EMPTY && rightEnd !== ko;
  let rank = rankFor(count, Number(leftOpen) + Number(rightOpen), 0);
  if (rightOpen) {
    let after = 0;
    const remaining = forward - right - 1;
    let end = rightEnd + offset;
    while (after < remaining && after < 6 && cells[end] === player) { after++; end += offset; }
    if (after) rank = Math.max(rank, rankFor(count + after,
      Number(leftOpen) + Number(after < remaining && cells[end] === EMPTY && end !== ko), 1));
  }
  if (leftOpen) {
    let after = 0;
    const remaining = backward - left - 1;
    let end = leftEnd - offset;
    while (after < remaining && after < 6 && cells[end] === player) { after++; end -= offset; }
    if (after) rank = Math.max(rank, rankFor(count + after,
      Number(rightOpen) + Number(after < remaining && cells[end] === EMPTY && end !== ko), 1));
  }
  return PATTERN_BY_RANK[rank];
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
  const geometry = pos * 4 + dirIdx;
  const forward = FORWARD_STEPS[geometry];
  const backward = BACKWARD_STEPS[geometry];
  const offset = LINE_OFFSETS[dirIdx];
  const cells = board.cells;
  const ko = ignoreKo ? -1 : board.koPosition;

  // Short edge diagonals cannot ever score an exact five.
  if (1 + forward + backward < 5) {
    return { count: 1, openEnds: 0, gaps: 0, gapPos: NO_POS,
      extendCount: 0, extend1: NO_POS, extend2: NO_POS };
  }

  const maxRun = 6; // enough to reject overlines
  let leftCount = 0, rightCount = 0;
  let leftEndIdx = pos - offset, rightEndIdx = pos + offset;
  while (leftCount < backward && leftCount < maxRun && cells[leftEndIdx] === player) {
    leftCount++;
    leftEndIdx -= offset;
  }
  while (rightCount < forward && rightCount < maxRun && cells[rightEndIdx] === player) {
    rightCount++;
    rightEndIdx += offset;
  }
  const leftOpen = leftCount < backward && cells[leftEndIdx] === EMPTY && ko !== leftEndIdx;
  const rightOpen = rightCount < forward && cells[rightEndIdx] === EMPTY && ko !== rightEndIdx;

  // Base (no gap) variant.
  const contiguousCount = leftCount + 1 + rightCount;
  let bestCount = contiguousCount;
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
    const remaining = forward - rightCount - 1;
    let farEndIdx = rightEndIdx + offset;
    if (remaining > 0 && cells[farEndIdx] === player) {
      let afterCount = 0;
      while (afterCount < remaining && afterCount < maxRun && cells[farEndIdx] === player) {
        afterCount++;
        farEndIdx += offset;
      }
      const farOpen = afterCount < remaining && cells[farEndIdx] === EMPTY && ko !== farEndIdx;

      const vCount = contiguousCount + afterCount;
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
    const remaining = backward - leftCount - 1;
    let farEndIdx = leftEndIdx - offset;
    if (remaining > 0 && cells[farEndIdx] === player) {
      let afterCount = 0;
      while (afterCount < remaining && afterCount < maxRun && cells[farEndIdx] === player) {
        afterCount++;
        farEndIdx -= offset;
      }
      const farOpen = afterCount < remaining && cells[farEndIdx] === EMPTY && ko !== farEndIdx;

      const vCount = contiguousCount + afterCount;
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
      // Every stone in a contiguous run sees the same pattern. Scan its first
      // stone once; the existing gap key still deduplicates separated runs.
      if (BACKWARD_STEPS[pos * 4 + dir] > 0 && board.cells[pos - LINE_OFFSETS[dir]] === player) continue;
      const info = scanLine(board, pos, dir, player);
      if (info.count < 2) continue;

      const pattern = classifyLine(info);
      if (pattern === null) continue;
      
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
        // The loop already excludes every stone after the run's start.
        lineKey = pos * 4 + dir;
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

