export type Stone = 'black' | 'white' | null;
export type PlayerColor = 'black' | 'white';
export type Action = 'reinforce' | 'rift';
export type GameMode = 'local' | 'vs-ai';
export type GamePhase = 'menu' | 'playing' | 'ended' | 'replay';

export interface Position {
  row: number;
  col: number;
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
  gameMode: GameMode;
  aiColor: PlayerColor | null;
  phase: GamePhase;
  moveHistory: MoveRecord[];
  aiThinking: boolean;
}

export interface MoveRecord {
  player: PlayerColor;
  action: Action;
  positions: Position[];
  removedStone?: Position;
}

export const BOARD_SIZE = 15;

export function createEmptyBoard(): Stone[][] {
  return Array.from({ length: BOARD_SIZE }, () => 
    Array.from({ length: BOARD_SIZE }, () => null)
  );
}

export function positionsEqual(a: Position | null, b: Position | null): boolean {
  if (!a || !b) return false;
  return a.row === b.row && a.col === b.col;
}

export function getOpponent(player: PlayerColor): PlayerColor {
  return player === 'black' ? 'white' : 'black';
}

