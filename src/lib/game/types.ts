export type Stone = 'black' | 'white' | null;
export type PlayerColor = 'black' | 'white';
export type Action = 'reinforce' | 'rift';
export type GameMode = 'local' | 'vs-ai' | 'ai-vs-ai';
export type GamePhase = 'menu' | 'playing' | 'ended' | 'replay';
/** 0 means "unlimited" (play until exhaustion). */
export type ScoreToWin = 0 | 1 | 3 | 5;
export type EndReason = 'score' | 'resign' | 'exhaustion' | null;
export type OpeningPreset = 'long-pro' | 'standard-empty' | 'legacy-black-center-white-first';

export interface Position {
  row: number;
  col: number;
}

export interface Scores {
  black: number;
  white: number;
}

export interface GameState {
  board: Stone[][];
  currentPlayer: PlayerColor;
  selectedAction: Action;
  pendingPlacements: Position[];
  pendingRift: Position | null;
  lastRiftedPosition: Position | null;
  lastPlacedPositions: Position[];
  winner: PlayerColor | null;
  winningLine: Position[] | null;
  scores: Scores;
  scoreToWin: ScoreToWin;
  openingPreset: OpeningPreset;
  endReason: EndReason;
  gameMode: GameMode;
  aiColor: PlayerColor | null;
  vsAiMaxTimeMs: number;
  spectateMaxTimeMsBlack: number;
  spectateMaxTimeMsWhite: number;
  phase: GamePhase;
  moveHistory: MoveRecord[];
  aiThinking: boolean;
}

export interface MoveRecord {
  player: PlayerColor;
  action: Action;
  positions: Position[];
  removedStone?: Position;
  /**
   * When present, this move caused one or more exact-5 scoring lines for `scoredBy`.
   * Each line is exactly 5 positions.
   */
  scoredBy?: PlayerColor;
  scoredLines?: Position[][];
}

export const BOARD_SIZE = 15;
export const CENTER_POS: Position = { row: Math.floor(BOARD_SIZE / 2), col: Math.floor(BOARD_SIZE / 2) };

export function createEmptyBoard(): Stone[][] {
  return Array.from({ length: BOARD_SIZE }, () => 
    Array.from({ length: BOARD_SIZE }, () => null)
  );
}

/**
 * Create the initial board for the given opening preset.
 */
export function createInitialBoard(openingPreset: OpeningPreset): Stone[][] {
  if (openingPreset === 'legacy-black-center-white-first') {
    const board = createEmptyBoard();
    board[CENTER_POS.row][CENTER_POS.col] = 'black';
    return board;
  }

  return createEmptyBoard();
}

export function getOpeningFirstPlayer(openingPreset: OpeningPreset): PlayerColor {
  return openingPreset === 'legacy-black-center-white-first' ? 'white' : 'black';
}

export function positionsEqual(a: Position | null, b: Position | null): boolean {
  if (!a || !b) return false;
  return a.row === b.row && a.col === b.col;
}

export function getOpponent(player: PlayerColor): PlayerColor {
  return player === 'black' ? 'white' : 'black';
}

