/**
 * Threat Detection and Fork Analysis
 * Identifies urgent tactical situations
 */

import { BOARD_CELLS, CANDIDATE_NEIGHBORS } from './constants';
import type { Board, CellIndex, Color, Fork, PatternCounts, Move, ReinforceMove, SingleWinMove } from './types';
import { ThreatLevel, EMPTY } from './types';
import { getOpponent, createSingleWinMove, createReinforceMove } from './utils';
import { checkWinAt, checkColinearityConstraint } from './board';
import { countPatterns, scanLine, classifyLine, patternAt, FORWARD_STEPS, BACKWARD_STEPS, LINE_OFFSETS } from './patterns';

// ---- Blocking mask (scratch) ----
export interface BlockingMask {
  mask: Uint32Array;
  stamp: number;
}

const BLOCK_MASK = new Uint32Array(BOARD_CELLS);
let blockStamp = 1;

function nextBlockStamp(): number {
  blockStamp = (blockStamp + 1) >>> 0;
  if (blockStamp === 0) {
    BLOCK_MASK.fill(0);
    blockStamp = 1;
  }
  return blockStamp;
}

/**
 * Compute a mask of squares that block opponent threats for `player`.
 * Marked squares are empty and legal to place (Ko respected unless `ignoreKo` is true).
 *
 * Returns a reference to a shared scratch mask; consume it immediately.
 */
export function getBlockingMask(board: Board, player: Color, ignoreKo: boolean = false): BlockingMask {
  const opponent = getOpponent(player);
  const stamp = nextBlockStamp();

  for (let pos = 0; pos < BOARD_CELLS; pos++) {
    if (board.cells[pos] !== opponent) continue;

    for (let dir = 0; dir < 4; dir++) {
      const info = scanLine(board, pos, dir, opponent, ignoreKo);
      const pattern = classifyLine(info);

      // Threat patterns where placing on extend/gap squares blocks the threat.
      if (
        pattern !== 'OPEN_FOUR' &&
        pattern !== 'GAP_FOUR' &&
        pattern !== 'HALF_FOUR' &&
        pattern !== 'OPEN_THREE'
      ) continue;

      if (info.extendCount >= 1 && info.extend1 >= 0) BLOCK_MASK[info.extend1] = stamp;
      if (info.extendCount >= 2 && info.extend2 >= 0) BLOCK_MASK[info.extend2] = stamp;
      if (info.gaps === 1 && info.gapPos >= 0) BLOCK_MASK[info.gapPos] = stamp;
    }
  }

  return { mask: BLOCK_MASK, stamp };
}

// Fork-candidate de-dup stamp (avoid per-call Uint8Array allocations).
const FORK_SEEN = new Uint32Array(BOARD_CELLS);
let forkStamp = 1;
function nextForkStamp(): number {
  forkStamp = (forkStamp + 1) >>> 0;
  if (forkStamp === 0) {
    FORK_SEEN.fill(0);
    forkStamp = 1;
  }
  return forkStamp;
}

function forkCandidates(board: Board): CellIndex[] {
  const stamp = nextForkStamp();
  const out: CellIndex[] = [];

  for (let pos = 0; pos < BOARD_CELLS; pos++) {
    if (board.cells[pos] === EMPTY) continue;
    for (const idx of CANDIDATE_NEIGHBORS[pos]) {
      if (board.cells[idx] !== EMPTY) continue;
      if (board.koPosition === idx) continue;
      if (FORK_SEEN[idx] === stamp) continue;
      FORK_SEEN[idx] = stamp;
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
    // Any significant one-gap pattern must have a friendly stone within two
    // steps of the placement. Fewer than two such directions cannot be a fork.
    // This cheap necessary condition avoids four full scans on isolated squares.
    let possibleDirections = 0;
    for (let dir = 0; dir < 4; dir++) {
      const geometry = pos * 4 + dir;
      const offset = LINE_OFFSETS[dir];
      const forward = FORWARD_STEPS[geometry], backward = BACKWARD_STEPS[geometry];
      if ((forward >= 1 && board.cells[pos + offset] === player) ||
          (forward >= 2 && board.cells[pos + offset * 2] === player) ||
          (backward >= 1 && board.cells[pos - offset] === player) ||
          (backward >= 2 && board.cells[pos - offset * 2] === player)) {
        if (++possibleDirections === 2) break;
      }
    }
    if (possibleDirections < 2) continue;
    
    // Temporarily place stone
    board.cells[pos] = player;
    
    const threats: string[] = [];
    
    for (let dir = 0; dir < 4; dir++) {
      const pattern = patternAt(board, pos, dir, player);
      
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
  const { mask, stamp } = getBlockingMask(board, player, false);
  const out: CellIndex[] = [];
  for (let i = 0; i < BOARD_CELLS; i++) {
    if (mask[i] === stamp) out.push(i);
  }
  return out;
}

export type ThreatKoMode = 'respectKo' | 'ignoreKo';

/**
 * Variant: find winning positions assuming Ko will not block the placement
 * on the opponent's next move (i.e. treat Ko as open for placement).
 */
export function findWinningPositionsAssumingKoClears(board: Board, player: Color): CellIndex[] {
  return getSingleStoneWinningSquares(board, player, 'ignoreKo');
}

/**
 * Find squares where placing a *single stone* would immediately win (exact-5).
 *
 * Note: in Gomoku Rift, Ko only blocks placement for the next move. Some callers
 * intentionally use `ignoreKo=true` to model “threats that may exist on the next ply”
 * when Ko is expected to clear.
 */
export function findWinningPositions(board: Board, player: Color, ignoreKo: boolean = false): CellIndex[] {
  return getSingleStoneWinningSquares(board, player, ignoreKo ? 'ignoreKo' : 'respectKo');
}

/**
 * Single source of truth: squares where placing ONE stone would immediately win (exact-5).
 *
 * Scan maximal contiguous runs and combine the counts on either side of an empty
 * endpoint. Pattern labels alone cannot distinguish XXXX_X from a legal exact five.
 * If `through` is supplied, inspect only runs containing those occupied squares;
 * callers checking a move must separately preserve threats elsewhere on the board.
 */
export function getSingleStoneWinningSquares(
  board: Board,
  player: Color,
  koMode: ThreatKoMode = 'respectKo',
  through?: readonly CellIndex[]
): CellIndex[] {
  const ko = koMode === 'ignoreKo' ? -1 : board.koPosition;
  const stamp = nextWinStamp();
  const out: CellIndex[] = [];
  const cells = board.cells;

  const addEnd = (idx: number, offset: number, remaining: number, count: number): void => {
    if (cells[idx] !== EMPTY || ko === idx) return;
    if (WIN_MASK[idx] === stamp) return;
    let next = idx + offset;
    while (remaining-- > 0 && cells[next] === player && count < 5) {
      count++;
      next += offset;
    }
    if (count !== 4) return;
    WIN_MASK[idx] = stamp;
    out.push(idx);
  };

  for (let i = 0; i < (through?.length ?? BOARD_CELLS); i++) {
    const pos = through ? through[i] : i;
    if (cells[pos] !== player) continue;
    for (let dir = 0; dir < 4; dir++) {
      const geometry = pos * 4 + dir;
      let backward = BACKWARD_STEPS[geometry];
      let forward = FORWARD_STEPS[geometry];
      const offset = LINE_OFFSETS[dir];
      let start = pos;
      if (!through && backward > 0 && cells[start - offset] === player) continue;
      while (through && backward > 0 && cells[start - offset] === player) {
        start -= offset;
        backward--;
        forward++;
      }

      let count = 1, end = start + offset;
      while (count <= forward && cells[end] === player && count < 5) {
        count++;
        end += offset;
      }
      if (count >= 5) continue;
      if (backward > 0) addEnd(start - offset, -offset, backward - 1, count);
      if (count <= forward) addEnd(end, offset, forward - count, count);
    }
  }

  return out;
}

/** Check an attack after makeMove, before scoring clears, using changed lines.
 * Previous winning squares must be supplied from the parent with Ko ignored.
 */
export function hasImmediateThreatAfterMove(
  board: Board, player: Color, move: Move, previousWinningSquares: readonly CellIndex[]
): boolean {
  // Existing threats may survive the move, including a square whose old Ko expired.
  for (const pos of previousWinningSquares) {
    if (board.cells[pos] === EMPTY && checkWinAt(board, pos, player)) return true;
  }
  // Removing an enemy stone can only create a new winning square at that cell.
  if (move.action === 'rift') return checkWinAt(board, move.pos, player);
  const placed = move.pos2 === null ? [move.pos1] : [move.pos1, move.pos2];
  return getSingleStoneWinningSquares(board, player, 'ignoreKo', placed).length > 0;
}

/** Exact match-ending placement, including intersecting lines and scoring pairs. */
export function getImmediateMatchWinningMove(
  board: Board, player: Color, pointsNeeded: number, koMode: ThreatKoMode = 'respectKo'
): ReinforceMove | SingleWinMove | null {
  // Each of two legal stones can complete at most four distinct lines.
  if (pointsNeeded > 8) return null;
  const squares = getSingleStoneWinningSquares(board, player, koMode);
  if (squares.length === 0) return null;
  if (pointsNeeded <= 1) return createSingleWinMove(squares[0]);
  const points = squares.map(pos => {
    let count = 0;
    for (let dir = 0; dir < 4; dir++) {
      const geometry = pos * 4 + dir, offset = LINE_OFFSETS[dir];
      let length = 1;
      for (let step = 1; step <= FORWARD_STEPS[geometry] && board.cells[pos + step * offset] === player; step++) length++;
      for (let step = 1; step <= BACKWARD_STEPS[geometry] && board.cells[pos - step * offset] === player; step++) length++;
      if (length === 5) count++;
    }
    return count;
  });
  for (let i = 0; i < squares.length; i++) {
    if (points[i] >= pointsNeeded) return createSingleWinMove(squares[i]);
  }
  // The collinearity rule keeps legal pair placements' scoring lines independent.
  for (let i = 0; i < squares.length; i++) for (let j = i + 1; j < squares.length; j++) {
    if (points[i] + points[j] >= pointsNeeded &&
        checkColinearityConstraint(board, squares[i], squares[j], player)) {
      return createReinforceMove(squares[i], squares[j]);
    }
  }
  return null;
}

// ---- winning-square de-dup stamp ----
const WIN_MASK = new Uint32Array(BOARD_CELLS);
let winStamp = 1;
function nextWinStamp(): number {
  winStamp = (winStamp + 1) >>> 0;
  if (winStamp === 0) {
    WIN_MASK.fill(0);
    winStamp = 1;
  }
  return winStamp;
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
    // Ko is only temporary; threats that are Ko-blocked right now may be real next turn.
    const info = scanLine(board, riftPos, dir, opponent, true);
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
    // Ko is only temporary; evaluate the threats this stone contributes to assuming
    // Ko will not block the opponent on their next move.
    const info = scanLine(board, riftPos, dir, opponent, true);
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

