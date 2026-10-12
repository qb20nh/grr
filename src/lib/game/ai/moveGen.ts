/**
 * Move Generation for Gomoku Rift
 * Generates and filters candidate moves with colinearity constraints
 */

import { BOARD_SIZE, BOARD_CELLS, CONFIG, CANDIDATE_NEIGHBORS } from './constants';
import type { Board, CellIndex, Color, Move, ScoredMove, ReinforceMove, RiftMove } from './types';
import { EMPTY, BLACK, WHITE } from './types';
import { getOpponent, createReinforceMove, createSingleWinMove, createRiftMove, isSingleWinMove, toIndex } from './utils';
import { isValidPlacement, checkColinearityConstraint, validateReinforce, makeMove, unmakeMove, getWinnerAfterMove } from './board';
import { evaluateSinglePosition, evaluateReinforceMove, createReinforceScorer } from './synergy';
import { evaluateRiftTarget, findWinningPositions, findWinningPositionsAssumingKoClears, getBlockingMask } from './threats';
import type { BlockingMask } from './threats';

export interface MatchContext {
  scores: { black: number; white: number };
  /** 0 means “unlimited” (play until exhaustion). */
  scoreToWin: number;
}

/**
 * Complete replies to an immediate match-ending threat. A heuristic top-K list
 * is unsafe here: attractive attacks can crowd out every legal defensive rift.
 * null means ordinary move generation is needed; [] means no evasion exists.
 */
export function generateImmediateResponses(board: Board, player: Color, match?: MatchContext): ScoredMove[] | null {
  const target = match?.scoreToWin ?? 1;
  if (target === 0) return null;
  const ownScore = player === BLACK ? match?.scores.black ?? 0 : match?.scores.white ?? 0;
  const opponent = getOpponent(player);
  const opponentScore = opponent === BLACK ? match?.scores.black ?? 0 : match?.scores.white ?? 0;
  const wins = findWinningPositions(board, player);
  if (wins.length > 0) {
    if (ownScore + 1 >= target) {
      return [{ move: createSingleWinMove(wins[0]), score: CONFIG.INFINITY, orderScore: CONFIG.INFINITY }];
    }
    // Nonterminal scoring clears stones; let the full match search model that.
    return null;
  }
  if (opponentScore + 1 < target) return null;
  const threats = findWinningPositionsAssumingKoClears(board, opponent);
  if (threats.length === 0) return null;

  const responses: ScoredMove[] = [];
  const scorer = createReinforceScorer(board, player, getBlockingMask(board, player));
  const addPair = (a: number, b: number): void => {
    if (!validateReinforce(board, a, b, player)) return;
    const score = scorer.pair(a, b);
    responses.push({ move: createReinforceMove(a, b), score, orderScore: score });
  };
  if (threats.length === 1) {
    // Every legal filler matters: remote second stones can create a counterthreat.
    for (let pos = 0; pos < BOARD_CELLS; pos++) addPair(threats[0], pos);
  } else if (threats.length === 2) {
    addPair(threats[0], threats[1]);
  }

  // Inspect every opposing stone, including low-ranked targets. Removing one
  // can expose a different exact-five or change the only winning square to Ko.
  for (let pos = 0; pos < BOARD_CELLS; pos++) {
    if (board.cells[pos] !== opponent) continue;
    const move = createRiftMove(pos);
    const undo = makeMove(board, move, player);
    const safe = getWinnerAfterMove(board, move, player) !== opponent &&
      findWinningPositions(board, opponent).length === 0;
    unmakeMove(board, undo, player);
    if (!safe) continue;
    const score = evaluateRiftTarget(board, pos, player);
    responses.push({ move, score, orderScore: score });
  }
  responses.sort((a, b) => b.score - a.score);
  return responses;
}

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

const SINGLE_SEEN = new Uint32Array(BOARD_CELLS);
let singleStamp = 1;
function nextSingleStamp(): number {
  singleStamp = (singleStamp + 1) >>> 0;
  if (singleStamp === 0) {
    SINGLE_SEEN.fill(0);
    singleStamp = 1;
  }
  return singleStamp;
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

// Critical-block membership scratch (avoid Set allocations in hot paths).
const CRITICAL_BLOCK_SEEN = new Uint32Array(BOARD_CELLS);
let criticalBlockStamp = 1;
function nextCriticalBlockStamp(): number {
  criticalBlockStamp = (criticalBlockStamp + 1) >>> 0;
  if (criticalBlockStamp === 0) {
    CRITICAL_BLOCK_SEEN.fill(0);
    criticalBlockStamp = 1;
  }
  return criticalBlockStamp;
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

    for (const idx of CANDIDATE_NEIGHBORS[i]) {
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
  player: Color,
  match?: MatchContext
): ScoredMove[] {
  const opponent = getOpponent(player);
  const scores = match?.scores ?? { black: 0, white: 0 };
  const scoreToWin = match?.scoreToWin ?? 1;
  const playerScore = player === BLACK ? scores.black : scores.white;
  const opponentScore = opponent === BLACK ? scores.black : scores.white;
  const playerOnMatchPoint = scoreToWin !== 0 && playerScore + 1 >= scoreToWin;
  const opponentOnMatchPoint = scoreToWin !== 0 && opponentScore + 1 >= scoreToWin;

  // A match-ending single needs no candidate scoring or pair enumeration.
  const scoringPositions = findWinningPositions(board, player);
  if (playerOnMatchPoint && scoringPositions.length > 0) {
    return [{ move: createSingleWinMove(scoringPositions[0]), score: CONFIG.INFINITY, orderScore: CONFIG.INFINITY }];
  }

  const blocking = getBlockingMask(board, player, false);

  // Materialize blocking positions once (used for must-block and bonuses).
  const blockingPositions: CellIndex[] = [];
  for (let i = 0; i < BOARD_CELLS; i++) {
    if (blocking.mask[i] === blocking.stamp) blockingPositions.push(i);
  }

  const scorer = createReinforceScorer(board, player, blocking);
  const candidates = getCandidatePositions(board);
  const scoredCandidates = candidates.map(pos => ({ pos, score: scorer.single(pos) }));
  scoredCandidates.sort((a, b) => b.score - a.score);
  
  // Take top candidates for pair generation
  const topCandidates = scoredCandidates.slice(0, 25);
  
  const moves: ScoredMove[] = [];
  
  // Nonterminal scoring singles remain candidates in multi-point matches.
  if (scoringPositions.length > 0) {
    // Otherwise, include a few scoring singles as high-value candidates (ordering only).
    // Keep this conservative: search should decide whether “taking a point” is worth it.
    const SCORE_BONUS = 120000;
    const scoredSingles = scoringPositions.map(pos => ({
      pos,
      score: scorer.single(pos) + SCORE_BONUS,
    }));
    scoredSingles.sort((a, b) => b.score - a.score);
    const topSingles = scoredSingles.slice(0, 6);
    for (const s of topSingles) {
      moves.push({
        move: createSingleWinMove(s.pos),
        score: s.score,
        orderScore: s.score,
      });
    }
  }
  
  // CRITICAL: Check if opponent can end the match on their next move (match point).
  // Ko only blocks placement until the next move. Since we are about to move now,
  // treat Ko as available when asking “can the opponent win on their next move?”.
  const opponentWinPositions = findWinningPositionsAssumingKoClears(board, opponent);
  const mustBlock = opponentOnMatchPoint && opponentWinPositions.length > 0;
  
  // If opponent can win next turn, blocking is MANDATORY
  // Blocking positions should include the opponent's winning squares
  const cStamp = nextCriticalBlockStamp();
  const criticalBlockArray: CellIndex[] = [];
  const addCritical = (pos: CellIndex): void => {
    if (CRITICAL_BLOCK_SEEN[pos] === cStamp) return;
    CRITICAL_BLOCK_SEEN[pos] = cStamp;
    criticalBlockArray.push(pos);
  };
  for (const pos of blockingPositions) addCritical(pos);
  for (const pos of opponentWinPositions) {
    if (isValidPlacement(board, pos)) addCritical(pos);
  }
  const isCritical = (pos: CellIndex): boolean => CRITICAL_BLOCK_SEEN[pos] === cStamp;
  
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
        
        const score = scorer.pair(blockPos, blockPos2);
        moves.push({
          move: createReinforceMove(blockPos, blockPos2),
          score: score + 500000, // HUGE bonus for double block
          orderScore: score + 500000,
        });
      }
      
      // Pair with top candidates
      for (const cand of topCandidates) {
        if (cand.pos === blockPos) continue;
        if (!checkColinearityConstraint(board, blockPos, cand.pos, player)) continue;
        
        const score = scorer.pair(blockPos, cand.pos);
        moves.push({
          move: createReinforceMove(blockPos, cand.pos),
          score: score + 300000, // Large bonus for blocking
          orderScore: score + 300000,
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
      const score = scorer.pair(pos1, pos2);
      
      // Bonus if one or both are blocking moves
      let finalScore = score;
      if (isCritical(pos1)) finalScore += mustBlock ? 200000 : 20000;
      if (isCritical(pos2)) finalScore += mustBlock ? 200000 : 20000;
      
      moves.push({
        move: createReinforceMove(pos1, pos2),
        score: finalScore,
        orderScore: finalScore,
      });
    }
  }
  
  // Sort by score and limit
  moves.sort((a, b) => b.score - a.score);
  
  // Remove duplicates (same pair in different order) using a numeric mask.
  // Also dedup single-stone scoring moves by position.
  const stamp = nextPairStamp();
  const single = nextSingleStamp();
  const uniqueMoves: ScoredMove[] = [];
  
  for (const m of moves) {
    const mv = m.move;
    if (isSingleWinMove(mv)) {
      if (SINGLE_SEEN[mv.pos1] === single) continue;
      SINGLE_SEEN[mv.pos1] = single;
      uniqueMoves.push(m);
      continue;
    }

    const rm = mv as ReinforceMove;
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
  player: Color,
  match?: MatchContext
): ScoredMove[] {
  const opponent = getOpponent(player);
  const scores = match?.scores ?? { black: 0, white: 0 };
  const scoreToWin = match?.scoreToWin ?? 1;
  const opponentScore = opponent === BLACK ? scores.black : scores.white;
  const opponentOnMatchPoint = scoreToWin !== 0 && opponentScore + 1 >= scoreToWin;
  const moves: ScoredMove[] = [];
  
  // If the opponent is on match point, rifting the right stone can be critical defense.
  const opponentWinPositions = findWinningPositionsAssumingKoClears(board, opponent);
  const opponentCanWin = opponentOnMatchPoint && opponentWinPositions.length > 0;
  
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
      orderScore: score,
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
  player: Color,
  match?: MatchContext
): ScoredMove[] {
  const responses = generateImmediateResponses(board, player, match);
  if (responses && responses.length > 0) return responses;
  const reinforceMoves = generateReinforceMoves(board, player, match);
  const riftMoves = generateRiftMoves(board, player, match);

  // Merge two already-sorted lists (avoid an extra O(n log n) sort in the hot path).
  const out: ScoredMove[] = new Array(reinforceMoves.length + riftMoves.length);
  let i = 0;
  let j = 0;
  let k = 0;

  while (i < reinforceMoves.length && j < riftMoves.length) {
    const a = reinforceMoves[i];
    const b = riftMoves[j];
    if (a.score >= b.score) {
      out[k++] = a;
      i++;
    } else {
      out[k++] = b;
      j++;
    }
  }
  while (i < reinforceMoves.length) out[k++] = reinforceMoves[i++];
  while (j < riftMoves.length) out[k++] = riftMoves[j++];

  return out;
}

/**
 * Generate only tactical moves (for quiescence search)
 * These are moves that create or respond to immediate threats
 */
export function generateTacticalMoves(
  board: Board,
  player: Color,
  match?: MatchContext
): ScoredMove[] {
  const responses = generateImmediateResponses(board, player, match);
  if (responses !== null) return responses;
  const opponent = getOpponent(player);
  const defending = findWinningPositionsAssumingKoClears(board, opponent).length > 0;
  const candidates = [...generateReinforceMoves(board, player, match), ...generateRiftMoves(board, player, match)];
  const tactical: ScoredMove[] = [];
  for (const candidate of candidates) {
    const undo = makeMove(board, candidate.move, player);
    const winner = getWinnerAfterMove(board, candidate.move, player);
    const forcing = winner === player || (winner === null &&
      (findWinningPositionsAssumingKoClears(board, player).length > 0 ||
        (defending && findWinningPositions(board, opponent).length === 0)));
    unmakeMove(board, undo, player);
    if (forcing) tactical.push(candidate);
  }
  // Bound attacking branches, while retaining all generated forcing rifts.
  // Mandatory defensive replies above are complete and never use this cap.
  tactical.sort((a, b) => b.score - a.score);
  let pairs = 0;
  return tactical.filter(m => m.move.action === 'rift' || ++pairs <= 12);
}

/**
 * Generate blocking moves specifically
 * Returns moves that stop opponent from winning
 */
export function generateBlockingMoves(
  board: Board,
  player: Color,
  match?: MatchContext
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
  const riftMoves = generateRiftMoves(board, player, match);
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

