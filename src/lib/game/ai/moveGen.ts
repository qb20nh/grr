/**
 * Move Generation for Gomoku Rift
 * Generates and filters candidate moves with colinearity constraints
 */

import { BOARD_SIZE, BOARD_CELLS, CONFIG } from './constants';
import type { Board, CellIndex, Color, Move, ScoredMove, ReinforceMove, RiftMove } from './types';
import { EMPTY } from './types';
import { getOpponent, createReinforceMove, createSingleWinMove, createRiftMove, toIndex, inBounds } from './utils';
import { isValidPlacement, checkColinearityConstraint, validateReinforce } from './board';
import { evaluateSinglePosition, evaluateReinforceMove } from './synergy';
import { evaluateRiftTarget, findWinningPositions, findWinningPositionsAssumingKoClears, getBlockingMask } from './threats';
import type { BlockingMask } from './threats';

// Precomputed neighbor lists (radius = CONFIG.CANDIDATE_RADIUS) for fast candidate generation.
const NEIGHBORS: readonly CellIndex[][] = (() => {
  const radius = CONFIG.CANDIDATE_RADIUS;
  const neighbors: CellIndex[][] = Array.from({ length: BOARD_CELLS }, () => []);

  for (let idx = 0; idx < BOARD_CELLS; idx++) {
    const row = Math.floor(idx / BOARD_SIZE);
    const col = idx % BOARD_SIZE;

    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = row + dr;
        const nc = col + dc;
        if (!inBounds(nr, nc)) continue;
        neighbors[idx].push(toIndex(nr, nc));
      }
    }
  }

  return neighbors;
})();

// ---- Scratch masks (avoid Set allocations in hot paths) ----
const CANDIDATE_SEEN = new Uint32Array(BOARD_CELLS);
let candidateStamp = 1;
function nextCandidateStamp(): number {
  candidateStamp = (candidateStamp + 1) >>> 0;
  if (candidateStamp === 0) {
    CANDIDATE_SEEN.fill(0);
    candidateStamp = 1;
  }
  return candidateStamp;
}

const PAIR_SEEN = new Uint32Array(BOARD_CELLS * BOARD_CELLS);
let pairStamp = 1;
function nextPairStamp(): number {
  pairStamp = (pairStamp + 1) >>> 0;
  if (pairStamp === 0) {
    PAIR_SEEN.fill(0);
    pairStamp = 1;
  }
  return pairStamp;
}

function pairKey(a: CellIndex, b: CellIndex): number {
  const min = a < b ? a : b;
  const max = a < b ? b : a;
  return min * BOARD_CELLS + max;
}

/**
 * Get candidate positions near existing stones
 */
export function getCandidatePositions(board: Board): CellIndex[] {
  const stamp = nextCandidateStamp();
  const out: CellIndex[] = [];

  // Find positions near existing stones
  for (let i = 0; i < BOARD_CELLS; i++) {
    if (board.cells[i] === EMPTY) continue;

    for (const idx of NEIGHBORS[i]) {
      // Fast placement check (idx already in-bounds).
      if (board.cells[idx] !== EMPTY) continue;
      if (board.koPosition === idx) continue;
      if (CANDIDATE_SEEN[idx] === stamp) continue;
      CANDIDATE_SEEN[idx] = stamp;
      out.push(idx);
    }
  }
  
  // If board is empty, use center area
  if (out.length === 0) {
    const center = Math.floor(BOARD_SIZE / 2);
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const idx = toIndex(center + dr, center + dc);
        if (board.cells[idx] !== EMPTY) continue;
        if (board.koPosition === idx) continue;
        if (CANDIDATE_SEEN[idx] === stamp) continue;
        CANDIDATE_SEEN[idx] = stamp;
        out.push(idx);
      }
    }
  }

  return out;
}

/**
 * Score and sort candidate positions
 */
export function scoreCandidates(
  board: Board,
  candidates: CellIndex[],
  player: Color,
  blocking?: BlockingMask
): { pos: CellIndex; score: number }[] {
  const bm = blocking ?? getBlockingMask(board, player, false);
  const scored = candidates.map(pos => ({
    pos,
    score: evaluateSinglePosition(board, pos, player, bm),
  }));
  
  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);
  
  // Limit to top candidates
  return scored.slice(0, CONFIG.MAX_CANDIDATES);
}

/**
 * Generate all valid reinforce move pairs (or single-stone winning moves)
 */
export function generateReinforceMoves(
  board: Board,
  player: Color
): ScoredMove[] {
  const opponent = getOpponent(player);
  const blocking = getBlockingMask(board, player, false);

  // Materialize blocking positions once (used for must-block and bonuses).
  const blockingPositions: CellIndex[] = [];
  for (let i = 0; i < BOARD_CELLS; i++) {
    if (blocking.mask[i] === blocking.stamp) blockingPositions.push(i);
  }

  const candidates = getCandidatePositions(board);
  const scoredCandidates = scoreCandidates(board, candidates, player, blocking);
  
  // Take top candidates for pair generation
  const topCandidates = scoredCandidates.slice(0, 25);
  
  const moves: ScoredMove[] = [];
  
  // Check for single-stone winning moves first (highest priority)
  const winningPositions = findWinningPositions(board, player);
  if (winningPositions.length > 0) {
    // Single stone win is the best possible move
    const winPos = winningPositions[0];
    moves.push({
      move: createSingleWinMove(winPos),
      score: CONFIG.INFINITY,
    });
    // Return immediately - no need to search further
    return moves;
  }
  
  // CRITICAL: Check if opponent can win next move
  // Ko only blocks placement until the next move. Since we are about to move now,
  // treat Ko as available when asking “can the opponent win on their next move?”.
  const opponentWinPositions = findWinningPositionsAssumingKoClears(board, opponent);
  const mustBlock = opponentWinPositions.length > 0;
  
  // If opponent can win next turn, blocking is MANDATORY
  // Blocking positions should include the opponent's winning squares
  const criticalBlocks = new Set<CellIndex>(blockingPositions);
  for (const pos of opponentWinPositions) {
    if (isValidPlacement(board, pos)) {
      criticalBlocks.add(pos);
    }
  }
  const criticalBlockArray = Array.from(criticalBlocks);
  
  // If we must block, generate blocking moves first with huge priority
  if (mustBlock && criticalBlockArray.length > 0) {
    // Generate all pairs that include at least one blocking position
    for (const blockPos of criticalBlockArray) {
      if (!isValidPlacement(board, blockPos)) continue;
      
      // Pair with other blocking positions
      for (const blockPos2 of criticalBlockArray) {
        if (blockPos2 <= blockPos) continue;
        if (!isValidPlacement(board, blockPos2)) continue;
        if (!checkColinearityConstraint(board, blockPos, blockPos2, player)) continue;
        
        const score = evaluateReinforceMove(board, blockPos, blockPos2, player, blocking);
        moves.push({
          move: createReinforceMove(blockPos, blockPos2),
          score: score + 500000, // HUGE bonus for double block
        });
      }
      
      // Pair with top candidates
      for (const cand of topCandidates) {
        if (cand.pos === blockPos) continue;
        if (!checkColinearityConstraint(board, blockPos, cand.pos, player)) continue;
        
        const score = evaluateReinforceMove(board, blockPos, cand.pos, player, blocking);
        moves.push({
          move: createReinforceMove(blockPos, cand.pos),
          score: score + 300000, // Large bonus for blocking
        });
      }
    }
  }
  
  // Generate pairs from top candidates (normal moves)
  for (let i = 0; i < topCandidates.length; i++) {
    for (let j = i + 1; j < topCandidates.length; j++) {
      const pos1 = topCandidates[i].pos;
      const pos2 = topCandidates[j].pos;
      
      // Check colinearity constraint
      if (!checkColinearityConstraint(board, pos1, pos2, player)) {
        continue;
      }
      
      // Score the pair
      const score = evaluateReinforceMove(board, pos1, pos2, player, blocking);
      
      // Bonus if one or both are blocking moves
      let finalScore = score;
      if (criticalBlocks.has(pos1)) finalScore += mustBlock ? 200000 : 20000;
      if (criticalBlocks.has(pos2)) finalScore += mustBlock ? 200000 : 20000;
      
      moves.push({
        move: createReinforceMove(pos1, pos2),
        score: finalScore,
      });
    }
  }
  
  // Sort by score and limit
  moves.sort((a, b) => b.score - a.score);
  
  // Remove duplicates (same pair in different order) using a numeric mask.
  const stamp = nextPairStamp();
  const uniqueMoves: ScoredMove[] = [];
  
  for (const m of moves) {
    const rm = m.move as ReinforceMove;
    const key = pairKey(rm.pos1, rm.pos2);
    if (PAIR_SEEN[key] === stamp) continue;
    PAIR_SEEN[key] = stamp;
    uniqueMoves.push(m);
  }
  
  return uniqueMoves.slice(0, CONFIG.MAX_PAIRS);
}

/**
 * Generate all valid rift moves
 */
export function generateRiftMoves(
  board: Board,
  player: Color
): ScoredMove[] {
  const opponent = getOpponent(player);
  const moves: ScoredMove[] = [];
  
  // Check if opponent can win next turn - rifting the right stone is critical
  const opponentWinPositions = findWinningPositionsAssumingKoClears(board, opponent);
  const opponentCanWin = opponentWinPositions.length > 0;
  
  // Find all opponent stones
  for (let i = 0; i < BOARD_CELLS; i++) {
    if (board.cells[i] !== opponent) continue;
    
    let score = evaluateRiftTarget(board, i, player);
    
    // If opponent can win, check if rifting this stone prevents it
    if (opponentCanWin) {
      // Temporarily remove the stone
      board.cells[i] = EMPTY;
      const newWinPositions = findWinningPositionsAssumingKoClears(board, opponent);
      board.cells[i] = opponent;
      
      // If rifting reduces or eliminates opponent's winning positions, huge bonus
      if (newWinPositions.length < opponentWinPositions.length) {
        score += 400000; // Critical defensive rift
      }
    }
    
    moves.push({
      move: createRiftMove(i),
      score,
    });
  }
  
  // Sort by score
  moves.sort((a, b) => b.score - a.score);
  
  return moves.slice(0, CONFIG.MAX_RIFTS);
}

/**
 * Generate all moves (reinforce + rift), sorted by estimated value
 */
export function generateAllMoves(
  board: Board,
  player: Color
): ScoredMove[] {
  const reinforceMoves = generateReinforceMoves(board, player);
  const riftMoves = generateRiftMoves(board, player);
  
  // Combine and sort
  const allMoves = [...reinforceMoves, ...riftMoves];
  allMoves.sort((a, b) => b.score - a.score);
  
  return allMoves;
}

/**
 * Generate only tactical moves (for quiescence search)
 * These are moves that create or respond to immediate threats
 */
export function generateTacticalMoves(
  board: Board,
  player: Color
): ScoredMove[] {
  const moves: ScoredMove[] = [];
  const opponent = getOpponent(player);
  const blocking = getBlockingMask(board, player, false);
  
  // 1. Winning moves
  const winningPositions = findWinningPositions(board, player);
  
  // 2. Blocking moves (if opponent has threats)
  const blockingPositions: CellIndex[] = [];
  for (let i = 0; i < BOARD_CELLS; i++) {
    if (blocking.mask[i] === blocking.stamp) blockingPositions.push(i);
  }
  
  // 3. Threat-creating moves
  const candidates = getCandidatePositions(board);
  const threatPositions: CellIndex[] = [];
  
  for (const pos of candidates) {
    if (!isValidPlacement(board, pos)) continue;
    
    // Temporarily place
    board.cells[pos] = player;
    
    // Check if creates four or better
    let createsThreat = false;
    for (let dir = 0; dir < 4; dir++) {
      let count = 1;
      const [dRow, dCol] = [[0,1],[1,0],[1,1],[1,-1]][dir];
      const row = Math.floor(pos / BOARD_SIZE);
      const col = pos % BOARD_SIZE;
      
      let r = row + dRow, c = col + dCol;
      while (inBounds(r, c) && board.cells[toIndex(r, c)] === player) {
        count++; r += dRow; c += dCol;
      }
      r = row - dRow; c = col - dCol;
      while (inBounds(r, c) && board.cells[toIndex(r, c)] === player) {
        count++; r -= dRow; c -= dCol;
      }
      
      if (count >= 4) {
        createsThreat = true;
        break;
      }
    }
    
    board.cells[pos] = EMPTY;
    
    if (createsThreat) {
      threatPositions.push(pos);
    }
  }
  
  // Combine all tactical positions
  const allTactical = new Set([
    ...winningPositions,
    ...blockingPositions,
    ...threatPositions,
  ]);
  
  // Generate pairs from tactical positions
  const tacticalArray = Array.from(allTactical);
  
  for (let i = 0; i < tacticalArray.length; i++) {
    for (let j = i + 1; j < tacticalArray.length; j++) {
      const pos1 = tacticalArray[i];
      const pos2 = tacticalArray[j];
      
      if (!isValidPlacement(board, pos1) || !isValidPlacement(board, pos2)) continue;
      if (!checkColinearityConstraint(board, pos1, pos2, player)) continue;
      
      const score = evaluateReinforceMove(board, pos1, pos2, player, blocking);
      moves.push({
        move: createReinforceMove(pos1, pos2),
        score,
      });
    }
  }
  
  // Also include high-value rift moves
  const riftMoves = generateRiftMoves(board, player);
  for (const rm of riftMoves.slice(0, 5)) {
    if (rm.score > 50000) { // Only high-value rifts
      moves.push(rm);
    }
  }
  
  moves.sort((a, b) => b.score - a.score);
  return moves.slice(0, 20);
}

/**
 * Generate blocking moves specifically
 * Returns moves that stop opponent from winning
 */
export function generateBlockingMoves(
  board: Board,
  player: Color
): ScoredMove[] {
  const opponent = getOpponent(player);
  const moves: ScoredMove[] = [];
  const blocking = getBlockingMask(board, player, false);
  
  // Find opponent's winning positions and blocking positions
  const opponentWinPositions = findWinningPositions(board, opponent);
  const blockingPositions: CellIndex[] = [];
  for (let i = 0; i < BOARD_CELLS; i++) {
    if (blocking.mask[i] === blocking.stamp) blockingPositions.push(i);
  }
  
  // Combine into critical blocks
  const criticalBlocks = new Set<CellIndex>(blockingPositions);
  for (const pos of opponentWinPositions) {
    if (isValidPlacement(board, pos)) {
      criticalBlocks.add(pos);
    }
  }
  const blockArray = Array.from(criticalBlocks);
  
  // Try to form pairs from blocking positions
  for (let i = 0; i < blockArray.length; i++) {
    for (let j = i + 1; j < blockArray.length; j++) {
      const pos1 = blockArray[i];
      const pos2 = blockArray[j];
      
      if (!isValidPlacement(board, pos1) || !isValidPlacement(board, pos2)) continue;
      if (!checkColinearityConstraint(board, pos1, pos2, player)) continue;
      
      const score = evaluateReinforceMove(board, pos1, pos2, player, blocking);
      moves.push({
        move: createReinforceMove(pos1, pos2),
        score: score + 500000, // Very high priority for double blocking
      });
    }
  }
  
  // Try single blocking + best other position
  const candidates = getCandidatePositions(board);
  const scoredCandidates = scoreCandidates(board, candidates, player, blocking);
  
  for (const blockPos of blockArray) {
    if (!isValidPlacement(board, blockPos)) continue;
    
    for (const cand of scoredCandidates.slice(0, 15)) {
      if (cand.pos === blockPos) continue;
      if (!checkColinearityConstraint(board, blockPos, cand.pos, player)) continue;
      
      const score = evaluateReinforceMove(board, blockPos, cand.pos, player, blocking);
      moves.push({
        move: createReinforceMove(blockPos, cand.pos),
        score: score + 300000,
      });
    }
  }
  
  // Also consider rifting the threat (rift moves already have proper scoring)
  const riftMoves = generateRiftMoves(board, player);
  for (const rm of riftMoves) {
    if (rm.score > 200000) { // Rift that breaks a major threat
      moves.push(rm);
    }
  }
  
  moves.sort((a, b) => b.score - a.score);
  
  // Remove duplicate reinforce moves
  const seen = new Set<string>();
  const uniqueMoves: ScoredMove[] = [];
  
  for (const m of moves) {
    if (m.move.action === 'reinforce') {
      const rm = m.move as ReinforceMove;
      const key = `${Math.min(rm.pos1, rm.pos2)}-${Math.max(rm.pos1, rm.pos2)}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueMoves.push(m);
      }
    } else {
      uniqueMoves.push(m);
    }
  }
  
  return uniqueMoves;
}

