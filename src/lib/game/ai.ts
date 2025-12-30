import type { Stone, Position, PlayerColor, GameState, Action } from './types';
import { BOARD_SIZE, getOpponent, positionsEqual } from './types';
import { isValidPlacement, checkColinearityConstraint, validateReinforceAction, getValidRiftTargets } from './validator';
import { checkWinAtPosition } from './winChecker';

interface ScoredMove {
  action: Action;
  positions: Position[];
  score: number;
}

const DIRECTIONS: [number, number][] = [
  [0, 1], [1, 0], [1, 1], [1, -1]
];

/**
 * Evaluates the score of a line from a position in all directions.
 * Higher scores for longer lines and open ends.
 */
function evaluatePosition(
  board: Stone[][],
  pos: Position,
  player: PlayerColor
): number {
  let totalScore = 0;

  for (const [dRow, dCol] of DIRECTIONS) {
    const { count, openEnds } = countLine(board, pos, dRow, dCol, player);
    totalScore += getLineScore(count, openEnds);
  }

  return totalScore;
}

/**
 * Counts consecutive stones in both directions from a position.
 */
function countLine(
  board: Stone[][],
  pos: Position,
  dRow: number,
  dCol: number,
  player: PlayerColor
): { count: number; openEnds: number } {
  let count = 1;
  let openEnds = 0;

  // Forward direction
  let r = pos.row + dRow;
  let c = pos.col + dCol;
  while (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE && board[r][c] === player) {
    count++;
    r += dRow;
    c += dCol;
  }
  if (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE && board[r][c] === null) {
    openEnds++;
  }

  // Backward direction
  r = pos.row - dRow;
  c = pos.col - dCol;
  while (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE && board[r][c] === player) {
    count++;
    r -= dRow;
    c -= dCol;
  }
  if (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE && board[r][c] === null) {
    openEnds++;
  }

  return { count, openEnds };
}

/**
 * Scores a line based on length and openness.
 */
function getLineScore(count: number, openEnds: number): number {
  if (count >= 5) return 100000;
  if (openEnds === 0) return 0; // Blocked line has no potential
  
  const scores: Record<number, Record<number, number>> = {
    4: { 1: 5000, 2: 10000 },   // Four in a row
    3: { 1: 200, 2: 1000 },      // Three in a row
    2: { 1: 10, 2: 50 },         // Two in a row
    1: { 1: 1, 2: 3 }            // Single stone
  };

  return scores[count]?.[openEnds] || 0;
}

/**
 * Evaluates the board position for a player.
 */
function evaluateBoard(board: Stone[][], player: PlayerColor): number {
  let score = 0;

  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      if (board[row][col] === player) {
        score += evaluatePosition(board, { row, col }, player);
      }
    }
  }

  return score;
}

/**
 * Gets all valid empty positions for stone placement.
 */
function getEmptyPositions(
  board: Stone[][],
  lastRiftedPosition: Position | null
): Position[] {
  const positions: Position[] = [];
  
  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      const pos = { row, col };
      if (isValidPlacement(board, pos, lastRiftedPosition)) {
        positions.push(pos);
      }
    }
  }

  return positions;
}

/**
 * Gets positions near existing stones (more relevant moves).
 */
function getRelevantPositions(
  board: Stone[][],
  lastRiftedPosition: Position | null
): Position[] {
  const relevantSet = new Set<string>();
  const range = 2;

  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      if (board[row][col] !== null) {
        // Add nearby empty positions
        for (let dr = -range; dr <= range; dr++) {
          for (let dc = -range; dc <= range; dc++) {
            const nr = row + dr;
            const nc = col + dc;
            const pos = { row: nr, col: nc };
            if (isValidPlacement(board, pos, lastRiftedPosition)) {
              relevantSet.add(`${nr},${nc}`);
            }
          }
        }
      }
    }
  }

  // If board is empty, use center positions
  if (relevantSet.size === 0) {
    const center = Math.floor(BOARD_SIZE / 2);
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        relevantSet.add(`${center + dr},${center + dc}`);
      }
    }
  }

  return Array.from(relevantSet).map(s => {
    const [row, col] = s.split(',').map(Number);
    return { row, col };
  });
}

/**
 * Checks if a position would create a winning line for the given player.
 */
function wouldWin(
  board: Stone[][],
  pos: Position,
  player: PlayerColor
): boolean {
  // Temporarily place stone
  const originalStone = board[pos.row][pos.col];
  board[pos.row][pos.col] = player;
  const wins = checkWinAtPosition(board, pos, player);
  board[pos.row][pos.col] = originalStone;
  return wins;
}

/**
 * Evaluates a reinforce move (placing two stones).
 */
function evaluateReinforceMove(
  board: Stone[][],
  positions: Position[],
  aiPlayer: PlayerColor,
  lastRiftedPosition: Position | null
): number {
  const opponent = getOpponent(aiPlayer);
  const validation = validateReinforceAction(board, positions, aiPlayer, lastRiftedPosition);
  
  if (!validation.valid) return -Infinity;

  // Create temporary board with the placements
  const tempBoard = board.map(row => [...row]);
  positions.forEach(pos => {
    tempBoard[pos.row][pos.col] = aiPlayer;
  });

  let score = 0;

  // Check for immediate win
  for (const pos of positions) {
    if (checkWinAtPosition(tempBoard, pos, aiPlayer)) {
      return 1000000; // Winning move
    }
  }

  // Evaluate board improvement
  const beforeScore = evaluateBoard(board, aiPlayer) - evaluateBoard(board, opponent);
  const afterScore = evaluateBoard(tempBoard, aiPlayer) - evaluateBoard(tempBoard, opponent);
  score += (afterScore - beforeScore);

  // Bonus for threatening positions
  for (const pos of positions) {
    score += evaluatePosition(tempBoard, pos, aiPlayer) * 2;
  }

  // Check if we're blocking opponent threats
  for (const pos of positions) {
    if (wouldWin(board, pos, opponent)) {
      score += 50000; // Blocking a winning position
    }
  }

  return score;
}

/**
 * Evaluates a rift move (removing opponent stone).
 */
function evaluateRiftMove(
  board: Stone[][],
  pos: Position,
  aiPlayer: PlayerColor
): number {
  const opponent = getOpponent(aiPlayer);
  
  if (board[pos.row][pos.col] !== opponent) {
    return -Infinity;
  }

  // Create temporary board with the removal
  const tempBoard = board.map(row => [...row]);
  tempBoard[pos.row][pos.col] = null;

  let score = 0;

  // Evaluate how much this hurts opponent's position
  const beforeOpponentScore = evaluateBoard(board, opponent);
  const afterOpponentScore = evaluateBoard(tempBoard, opponent);
  score += (beforeOpponentScore - afterOpponentScore) * 1.5;

  // Extra bonus for breaking strong threats
  const stoneValue = evaluatePosition(board, pos, opponent);
  score += stoneValue;

  // Check if this breaks an opponent's 4-in-a-row
  for (const [dRow, dCol] of DIRECTIONS) {
    const { count } = countLine(board, pos, dRow, dCol, opponent);
    if (count >= 4) {
      score += 20000;
    } else if (count === 3) {
      score += 2000;
    }
  }

  return score;
}

/**
 * Finds the best reinforce move for the AI.
 */
function findBestReinforceMove(
  board: Stone[][],
  aiPlayer: PlayerColor,
  lastRiftedPosition: Position | null
): ScoredMove | null {
  const positions = getRelevantPositions(board, lastRiftedPosition);
  let bestMove: ScoredMove | null = null;
  let bestScore = -Infinity;

  // Try all pairs of valid positions
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      const pos1 = positions[i];
      const pos2 = positions[j];

      const score = evaluateReinforceMove(board, [pos1, pos2], aiPlayer, lastRiftedPosition);
      
      if (score > bestScore) {
        bestScore = score;
        bestMove = {
          action: 'reinforce',
          positions: [pos1, pos2],
          score
        };
      }
    }
  }

  return bestMove;
}

/**
 * Finds the best rift move for the AI.
 */
function findBestRiftMove(
  board: Stone[][],
  aiPlayer: PlayerColor
): ScoredMove | null {
  const targets = getValidRiftTargets(board, aiPlayer);
  let bestMove: ScoredMove | null = null;
  let bestScore = -Infinity;

  for (const pos of targets) {
    const score = evaluateRiftMove(board, pos, aiPlayer);
    
    if (score > bestScore) {
      bestScore = score;
      bestMove = {
        action: 'rift',
        positions: [pos],
        score
      };
    }
  }

  return bestMove;
}

/**
 * Main AI decision function.
 * Returns the best move (either reinforce or rift).
 */
export function findBestMove(state: GameState): ScoredMove | null {
  const aiPlayer = state.aiColor;
  if (!aiPlayer) return null;

  const reinforceMove = findBestReinforceMove(state.board, aiPlayer, state.lastRiftedPosition);
  const riftMove = findBestRiftMove(state.board, aiPlayer);

  // Compare and return the best action
  if (!reinforceMove && !riftMove) return null;
  if (!reinforceMove) return riftMove;
  if (!riftMove) return reinforceMove;

  // Bias toward reinforce unless rift is significantly better
  // (Building is generally more valuable than destroying)
  const riftThreshold = 1.5;
  if (riftMove.score > reinforceMove.score * riftThreshold) {
    return riftMove;
  }

  return reinforceMove;
}

/**
 * Executes the AI's turn.
 */
export function executeAiMove(
  state: GameState,
  onReinforce: (positions: Position[]) => void,
  onRift: (pos: Position) => void
): void {
  const move = findBestMove(state);
  
  if (!move) {
    console.warn('AI could not find a valid move');
    return;
  }

  if (move.action === 'reinforce') {
    onReinforce(move.positions);
  } else {
    onRift(move.positions[0]);
  }
}

