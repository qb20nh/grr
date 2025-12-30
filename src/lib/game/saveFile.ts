/**
 * Save file serialization for Gomoku Rift matches
 * Format: .grr (Gomoku Rift Replay)
 */

import type { GameState, MoveRecord, Position, PlayerColor, GameMode, Action } from './types';

const FORMAT_VERSION = 'GRR1';

export interface SaveFileMetadata {
  version: string;
  date: string;
  mode: GameMode;
  blackPlayer: 'human' | 'ai';
  whitePlayer: 'human' | 'ai';
  winner: PlayerColor | null;
  moveCount: number;
}

export interface SaveFileData {
  metadata: SaveFileMetadata;
  moves: MoveRecord[];
}

/**
 * Serialize a position to compact notation: "row,col"
 */
function serializePosition(pos: Position): string {
  return `${pos.row},${pos.col}`;
}

/**
 * Parse a position from compact notation
 */
function parsePosition(str: string): Position {
  const [row, col] = str.split(',').map(Number);
  return { row, col };
}

/**
 * Serialize a single move to compact notation
 * Format: "bR7,7;7,8" or "wX6,6"
 */
function serializeMove(move: MoveRecord): string {
  const player = move.player === 'black' ? 'b' : 'w';
  const action = move.action === 'reinforce' ? 'R' : 'X';
  
  if (move.action === 'rift' && move.removedStone) {
    return `${player}${action}${serializePosition(move.removedStone)}`;
  }
  
  const positions = move.positions.map(serializePosition).join(';');
  return `${player}${action}${positions}`;
}

/**
 * Parse a move from compact notation
 */
function parseMove(line: string): MoveRecord {
  const player: PlayerColor = line[0] === 'b' ? 'black' : 'white';
  const action: Action = line[1] === 'R' ? 'reinforce' : 'rift';
  const rest = line.slice(2);
  
  if (action === 'rift') {
    return {
      player,
      action,
      positions: [],
      removedStone: parsePosition(rest)
    };
  }
  
  const positions = rest.split(';').map(parsePosition);
  return { player, action, positions };
}

/**
 * Serialize the full game state to .grr format
 */
export function serializeGame(state: GameState): string {
  const now = new Date().toISOString();
  const blackPlayer = state.gameMode === 'vs-ai' && state.aiColor === 'black' ? 'ai' : 'human';
  const whitePlayer = state.gameMode === 'vs-ai' && state.aiColor === 'white' ? 'ai' : 'human';
  
  const header = [
    FORMAT_VERSION,
    `date:${now}`,
    `mode:${state.gameMode}`,
    `black:${blackPlayer}`,
    `white:${whitePlayer}`,
    `winner:${state.winner ?? 'none'}`,
    `moves:${state.moveHistory.length}`
  ].join('\n');
  
  const moves = state.moveHistory.map(serializeMove).join('\n');
  
  return `${header}\n---\n${moves}`;
}

/**
 * Parse a .grr save file into structured data
 */
export function parseGame(content: string): SaveFileData {
  const [headerSection, movesSection] = content.split('\n---\n');
  const headerLines = headerSection.split('\n');
  
  const version = headerLines[0];
  if (version !== FORMAT_VERSION) {
    throw new Error(`Unsupported save file version: ${version}`);
  }
  
  const parseHeader = (prefix: string): string => {
    const line = headerLines.find(l => l.startsWith(prefix));
    return line?.slice(prefix.length) ?? '';
  };
  
  const metadata: SaveFileMetadata = {
    version,
    date: parseHeader('date:'),
    mode: parseHeader('mode:') as GameMode,
    blackPlayer: parseHeader('black:') as 'human' | 'ai',
    whitePlayer: parseHeader('white:') as 'human' | 'ai',
    winner: parseHeader('winner:') === 'none' ? null : parseHeader('winner:') as PlayerColor,
    moveCount: parseInt(parseHeader('moves:'), 10)
  };
  
  const moves = movesSection
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(parseMove);
  
  return { metadata, moves };
}

/**
 * Generate a filename for the save file
 */
export function generateFilename(state: GameState): string {
  const date = new Date().toISOString().slice(0, 10);
  const result = state.winner ? `${state.winner}-wins` : 'incomplete';
  return `gomoku-rift-${date}-${result}.grr`;
}

/**
 * Download the game as a .grr save file
 */
export function downloadSaveFile(state: GameState, filename?: string): void {
  const content = serializeGame(state);
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  
  const a = document.createElement('a');
  a.href = url;
  a.download = filename ?? generateFilename(state);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

