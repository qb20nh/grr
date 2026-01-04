/**
 * Save file serialization for Gomoku Rift matches
 * Format: .grr (Gomoku Rift Replay)
 *
 * GRR1: Original format (no integrity check)
 * GRR2: Adds SHA-256 checksum, opening preset, scores, scoreToWin, endReason
 */

import type {
  GameState,
  MoveRecord,
  Position,
  PlayerColor,
  GameMode,
  Action,
  OpeningPreset,
  ScoreToWin,
  EndReason,
} from './types';
import {
  LONG_PRO_MIN_MANHATTAN_FROM_CENTER,
} from './openingRules';

const FORMAT_VERSION_V1 = 'GRR1';
const FORMAT_VERSION_V2 = 'GRR2';
const CENTER = 7; // Board center (15x15 board)

export interface SaveFileMetadata {
  version: string;
  date: string;
  mode: GameMode;
  opening: OpeningPreset;
  scoreToWin: ScoreToWin;
  blackPlayer: 'human' | 'ai';
  whitePlayer: 'human' | 'ai';
  winner: PlayerColor | null;
  endReason: EndReason;
  scores: { black: number; white: number };
  moveCount: number;
  /** SHA-256 hex (GRR2 only; null for GRR1). */
  hash: string | null;
}

export interface SaveFileData {
  metadata: SaveFileMetadata;
  moves: MoveRecord[];
}

export class IntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntegrityError';
  }
}

// ---------------------------------------------------------------------------
// Position helpers
// ---------------------------------------------------------------------------

function serializePosition(pos: Position): string {
  return `${pos.row},${pos.col}`;
}

function parsePosition(str: string): Position {
  const [row, col] = str.split(',').map(Number);
  return { row, col };
}

// ---------------------------------------------------------------------------
// Move serialization (shared between GRR1 and GRR2)
// ---------------------------------------------------------------------------

/**
 * Serialize a single move to compact notation.
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

function parseMove(line: string): MoveRecord {
  const player: PlayerColor = line[0] === 'b' ? 'black' : 'white';
  const action: Action = line[1] === 'R' ? 'reinforce' : 'rift';
  const rest = line.slice(2);

  if (action === 'rift') {
    return {
      player,
      action,
      positions: [],
      removedStone: parsePosition(rest),
    };
  }

  const positions = rest.split(';').map(parsePosition);
  return { player, action, positions };
}

// ---------------------------------------------------------------------------
// SHA-256 helpers (WebCrypto)
// ---------------------------------------------------------------------------

async function sha256Hex(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const buf = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// GRR2 serialization (async because of WebCrypto)
// ---------------------------------------------------------------------------

/**
 * Serialize game state to GRR2 format with SHA-256 checksum.
 */
export async function serializeGameV2(state: GameState): Promise<string> {
  const now = new Date().toISOString();
  const blackPlayer =
    state.gameMode === 'ai-vs-ai'
      ? 'ai'
      : state.gameMode === 'vs-ai' && state.aiColor === 'black'
        ? 'ai'
        : 'human';
  const whitePlayer =
    state.gameMode === 'ai-vs-ai'
      ? 'ai'
      : state.gameMode === 'vs-ai' && state.aiColor === 'white'
        ? 'ai'
        : 'human';

  // Build canonical header lines (order matters for hashing)
  const headerLines = [
    FORMAT_VERSION_V2,
    `date:${now}`,
    `mode:${state.gameMode}`,
    `opening:${state.openingPreset}`,
    `scoreToWin:${state.scoreToWin}`,
    `black:${blackPlayer}`,
    `white:${whitePlayer}`,
    `winner:${state.winner ?? 'none'}`,
    `endReason:${state.endReason ?? 'none'}`,
    `scores:${state.scores.black},${state.scores.white}`,
    `moves:${state.moveHistory.length}`,
  ];

  const movesSection = state.moveHistory.map(serializeMove).join('\n');
  const payload = headerLines.join('\n') + '\n---\n' + movesSection;
  const hash = await sha256Hex(payload);

  // Insert hash line after header, before delimiter
  return headerLines.join('\n') + `\nhash:${hash}\n---\n` + movesSection;
}

// ---------------------------------------------------------------------------
// GRR1 serialization (sync, for backward compat / fallback)
// ---------------------------------------------------------------------------

export function serializeGameV1(state: GameState): string {
  const now = new Date().toISOString();
  const blackPlayer =
    state.gameMode === 'ai-vs-ai'
      ? 'ai'
      : state.gameMode === 'vs-ai' && state.aiColor === 'black'
        ? 'ai'
        : 'human';
  const whitePlayer =
    state.gameMode === 'ai-vs-ai'
      ? 'ai'
      : state.gameMode === 'vs-ai' && state.aiColor === 'white'
        ? 'ai'
        : 'human';

  const header = [
    FORMAT_VERSION_V1,
    `date:${now}`,
    `mode:${state.gameMode}`,
    `black:${blackPlayer}`,
    `white:${whitePlayer}`,
    `winner:${state.winner ?? 'none'}`,
    `moves:${state.moveHistory.length}`,
  ].join('\n');

  const moves = state.moveHistory.map(serializeMove).join('\n');
  return `${header}\n---\n${moves}`;
}

// ---------------------------------------------------------------------------
// Parsing (supports both GRR1 and GRR2)
// ---------------------------------------------------------------------------

/**
 * Parse a .grr save file. For GRR2, verifies the SHA-256 checksum.
 * Throws IntegrityError if checksum mismatch, Error for other parse issues.
 */
export async function parseGame(content: string): Promise<SaveFileData> {
  // Normalize line endings
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const [headerSection, movesSection] = normalized.split('\n---\n');
  if (movesSection === undefined) {
    throw new Error('Invalid save file: missing --- delimiter');
  }

  const headerLines = headerSection.split('\n');
  const version = headerLines[0]?.trim() ?? '';

  const parseHeader = (prefix: string): string => {
    const line = headerLines.find((l) => l.startsWith(prefix));
    return line?.slice(prefix.length) ?? '';
  };

  const moves = movesSection
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map(parseMove);

  if (version === FORMAT_VERSION_V2) {
    // Verify checksum
    const storedHash = parseHeader('hash:');
    if (!storedHash) {
      throw new IntegrityError('GRR2 file missing hash');
    }

    // Reconstruct canonical payload (header without hash line, then moves)
    const canonicalHeaderLines = headerLines.filter(
      (l) => !l.startsWith('hash:')
    );
    const canonicalPayload =
      canonicalHeaderLines.join('\n') + '\n---\n' + movesSection;
    const computed = await sha256Hex(canonicalPayload);

    if (computed !== storedHash) {
      throw new IntegrityError(
        `Checksum mismatch: file may be corrupted or modified`
      );
    }

    const scoresParts = parseHeader('scores:').split(',').map(Number);
    const metadata: SaveFileMetadata = {
      version,
      date: parseHeader('date:'),
      mode: (parseHeader('mode:') || 'local') as GameMode,
      opening: (parseHeader('opening:') || 'long-pro') as OpeningPreset,
      scoreToWin: (parseInt(parseHeader('scoreToWin:'), 10) || 1) as ScoreToWin,
      blackPlayer: (parseHeader('black:') || 'human') as 'human' | 'ai',
      whitePlayer: (parseHeader('white:') || 'human') as 'human' | 'ai',
      winner:
        parseHeader('winner:') === 'none'
          ? null
          : (parseHeader('winner:') as PlayerColor),
      endReason:
        parseHeader('endReason:') === 'none'
          ? null
          : (parseHeader('endReason:') as EndReason),
      scores: {
        black: scoresParts[0] ?? 0,
        white: scoresParts[1] ?? 0,
      },
      moveCount: parseInt(parseHeader('moves:'), 10) || moves.length,
      hash: storedHash,
    };

    return { metadata, moves };
  }

  if (version === FORMAT_VERSION_V1) {
    const winner =
      parseHeader('winner:') === 'none'
        ? null
        : (parseHeader('winner:') as PlayerColor);

    // Infer opening preset from move patterns (GRR1 didn't store this)
    let opening: OpeningPreset = 'long-pro';
    if (moves.length > 0) {
      const firstMove = moves[0];
      if (firstMove.player === 'white') {
        // White moves first → legacy preset (black pre-placed at center)
        opening = 'legacy-black-center-white-first';
      } else if (
        firstMove.action === 'reinforce' &&
        firstMove.positions.length === 1 &&
        firstMove.positions[0].row === CENTER &&
        firstMove.positions[0].col === CENTER
      ) {
        // Black's first move is single stone at center → likely long-pro
        // Verify by checking third move (Black's second) if available
        opening = 'long-pro';

        if (moves.length >= 3) {
          const thirdMove = moves[2]; // Black's second move
          if (thirdMove.player === 'black' && thirdMove.action === 'reinforce') {
            // Check if stones are inside restricted region (would violate Long Pro)
            const isInsideRestricted = thirdMove.positions.some((pos) => {
              const dr = Math.abs(pos.row - CENTER);
              const dc = Math.abs(pos.col - CENTER);
              return dr + dc < LONG_PRO_MIN_MANHATTAN_FROM_CENTER;
            });
            if (isInsideRestricted) {
              // Third move violates Long Pro restriction → must be standard
              opening = 'standard-empty';
            }
          }
        }
      } else {
        // Otherwise assume standard empty board
        opening = 'standard-empty';
      }
    }

    // Infer scores from winner (GRR1 didn't store scores)
    // With default scoreToWin=1, winner would have 1 point
    const scores = { black: 0, white: 0 };
    if (winner) {
      scores[winner] = 1;
    }

    const metadata: SaveFileMetadata = {
      version,
      date: parseHeader('date:'),
      mode: (parseHeader('mode:') || 'local') as GameMode,
      opening,
      scoreToWin: 1, // GRR1 didn't store this; default to 1
      blackPlayer: (parseHeader('black:') || 'human') as 'human' | 'ai',
      whitePlayer: (parseHeader('white:') || 'human') as 'human' | 'ai',
      winner,
      endReason: winner ? 'score' : null, // Infer from winner
      scores,
      moveCount: parseInt(parseHeader('moves:'), 10) || moves.length,
      hash: null,
    };

    return { metadata, moves };
  }

  throw new Error(`Unsupported save file version: ${version}`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a filename for the save file.
 */
export function generateFilename(state: GameState): string {
  const date = new Date().toISOString().slice(0, 10);
  const result = state.winner ? `${state.winner}-wins` : 'incomplete';
  return `gomoku-rift-${date}-${result}.grr`;
}

/**
 * Download the game as a .grr save file (GRR2 format with checksum).
 */
export async function downloadSaveFile(
  state: GameState,
  filename?: string
): Promise<void> {
  const content = await serializeGameV2(state);
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
