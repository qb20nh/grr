/**
 * AI Engine Types for Gomoku Rift
 * Optimized for two-stone placement and rift mechanics
 */

// Board cell values
export const EMPTY = 0;
export const BLACK = 1;
export const WHITE = 2;

export type CellValue = typeof EMPTY | typeof BLACK | typeof WHITE;
export type Color = typeof BLACK | typeof WHITE;

// Position as flat index (0-224 for 15x15 board)
export type CellIndex = number;

// Position as row/col
export interface Position {
  row: number;
  col: number;
}

// Move types
export type ActionType = 'reinforce' | 'rift';

export interface ReinforceMove {
  action: 'reinforce';
  pos1: CellIndex;
  pos2: CellIndex;
}

// Single stone winning move - only allowed when it immediately wins
export interface SingleWinMove {
  action: 'reinforce';
  pos1: CellIndex;
  pos2: null; // Marker for single stone move
  isWinningMove: true;
}

export interface RiftMove {
  action: 'rift';
  pos: CellIndex;
}

export type Move = ReinforceMove | SingleWinMove | RiftMove;

// Scored move for move ordering
export interface ScoredMove {
  move: Move;
  score: number;
  /**
   * Optional ordering score used by `orderMoves`. When absent, callers should fall back to `score`.
   * Kept on the object to avoid per-node allocation of parallel arrays during search.
   */
  orderScore?: number;
}

// Undo information for make/unmake
export interface UndoInfo {
  move: Move;
  prevHash: bigint;
  prevKo: CellIndex | null;
  capturedStone?: CellValue; // For rift moves
}

// Board state
export interface Board {
  cells: Uint8Array;      // 225 cells
  blackCount: number;
  whiteCount: number;
  hash: bigint;
  koPosition: CellIndex | null;  // Position blocked by Ko rule
}

// Pattern types for evaluation
export enum PatternType {
  FIVE = 'FIVE',
  OPEN_FOUR = 'OPEN_FOUR',
  HALF_FOUR = 'HALF_FOUR',
  OPEN_THREE = 'OPEN_THREE',
  HALF_THREE = 'HALF_THREE',
  OPEN_TWO = 'OPEN_TWO',
  HALF_TWO = 'HALF_TWO',
  GAP_FOUR = 'GAP_FOUR',
  GAP_THREE = 'GAP_THREE',
}

export interface Pattern {
  type: PatternType;
  positions: CellIndex[];
  direction: number; // 0-3 for the 4 directions
}

export interface PatternCounts {
  [PatternType.FIVE]: number;
  [PatternType.OPEN_FOUR]: number;
  [PatternType.HALF_FOUR]: number;
  [PatternType.OPEN_THREE]: number;
  [PatternType.HALF_THREE]: number;
  [PatternType.OPEN_TWO]: number;
  [PatternType.HALF_TWO]: number;
  [PatternType.GAP_FOUR]: number;
  [PatternType.GAP_THREE]: number;
}

// Threat levels
export enum ThreatLevel {
  NONE = 0,
  MINOR = 1,
  MODERATE = 2,
  SEVERE = 3,
  CRITICAL = 4,
  WINNING = 5,
}

// Fork information
export interface Fork {
  position: CellIndex;
  threats: PatternType[];
  count: number;
}

// Transposition table entry
export type TTFlag = 'exact' | 'lower' | 'upper';

export interface TTEntry {
  hash: bigint;
  depth: number;
  score: number;
  flag: TTFlag;
  bestMove: Move | null;
  age: number;
}

// Search result
export interface SearchResult {
  completed: boolean;
  score: number;
  move: Move | null;
  nodes?: number;
  depth?: number;
}

// Game phase for time management
export type GamePhase = 'opening' | 'midgame' | 'endgame';

// AI configuration
export interface AIConfig {
  maxTime: number;
  maxDepth: number;
  debug: boolean;
}

// Worker message types
export interface FindMoveRequest {
  type: 'findBestMove';
  state: {
    board: number[];
    aiColor: 'black' | 'white';
    lastRiftedPosition: number | null;
  };
  config?: Partial<AIConfig>;
}

export interface MoveResultMessage {
  type: 'result';
  move: {
    action: 'reinforce' | 'rift';
    positions: Position[];
    score: number;
    depth: number;
    nodes: number;
    time: number;
  } | null;
}

export interface ProgressMessage {
  type: 'progress';
  depth: number;
  score: number;
  nodes: number;
}

export type WorkerMessage = FindMoveRequest;
export type WorkerResponse = MoveResultMessage | ProgressMessage;

