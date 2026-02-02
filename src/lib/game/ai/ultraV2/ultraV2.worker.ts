/**
 * UltraV2 sub-worker (portfolio / Lazy-SMP style)
 *
 * Runs a full single-thread search on the root position using a shared transposition table.
 * Each worker uses a different root-move hint to diversify PV exploration.
 */
import {
  BOARD_SIZE,
  boardFrom2D,
  findBestMove,
  generateAllMoves,
  BLACK,
  WHITE,
  TranspositionTable,
} from '../index';
import type { Board, Color, Move } from '../types';
import type { SharedTranspositionTableBacking } from '../transposition';
import type { OpeningPreset } from '../../types';
import { getOpeningPly1ReplyMoveFilter, getOpeningRootMoveFilter } from '../openingFilters';
import { LONG_PRO_RIFT_FORBIDDEN_FIRST_TURNS } from '../../riftRules';

const NO_RIFT_FILTER = (m: Move): boolean => m.action !== 'rift';

function combineMoveFilters(
  a: ((m: Move) => boolean) | null,
  b: ((m: Move) => boolean) | null
): ((m: Move) => boolean) | null {
  if (a && b) return (m: Move) => a(m) && b(m);
  return a ?? b;
}

function noRiftFilterForOpening(openingPreset: OpeningPreset, moveIndex: number): ((m: Move) => boolean) | null {
  if (openingPreset !== 'long-pro') return null;
  return moveIndex < LONG_PRO_RIFT_FORBIDDEN_FIRST_TURNS ? NO_RIFT_FILTER : null;
}

type LegacyBoard = (string | null)[][];

interface WorkerState {
  board: LegacyBoard;
  playerToMove: 'black' | 'white';
  lastRiftedPosition: { row: number; col: number } | null;
  scores: { black: number; white: number };
  scoreToWin: number;
  openingPreset: OpeningPreset;
  moveIndex: number;
}

interface InitSharedTTRequest {
  type: 'initSharedTT';
  backing: SharedTranspositionTableBacking;
}

interface SearchRequest {
  type: 'search';
  requestId: number;
  workerIndex: number;
  state: WorkerState;
  deadlineMs: number;
  maxDepth: number;
}

type InMsg = InitSharedTTRequest | SearchRequest;

interface ReadyResponse {
  type: 'ultraV2Ready';
}

interface SearchResponse {
  type: 'ultraV2Result';
  requestId: number;
  completed: boolean;
  move: Move | null;
  score: number;
  depth: number;
  nodes: number;
}

function normalizeMoveIndex(value: unknown): number {
  if (typeof value !== 'number') return 0;
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

function normalizeOpeningPreset(value: unknown): OpeningPreset {
  if (value === 'long-pro' || value === 'standard-empty' || value === 'legacy-black-center-white-first') {
    return value;
  }
  return 'long-pro';
}

function normalizeNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number') return fallback;
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function normalizeScores(value: unknown): { black: number; white: number } {
  const v = value as any;
  return {
    black: normalizeNonNegativeInt(v?.black, 0),
    white: normalizeNonNegativeInt(v?.white, 0),
  };
}

function normalizeScoreToWin(value: unknown): number {
  return normalizeNonNegativeInt(value, 1);
}

function convertState(state: WorkerState): { board: Board; player: Color } {
  let koPosition: number | null = null;
  if (state.lastRiftedPosition) {
    koPosition = state.lastRiftedPosition.row * BOARD_SIZE + state.lastRiftedPosition.col;
  }
  const board = boardFrom2D(state.board, koPosition);
  const player: Color = state.playerToMove === 'black' ? BLACK : WHITE;
  return { board, player };
}

function msLeft(deadlineMs: number): number {
  return deadlineMs - Date.now();
}

let tt: TranspositionTable | null = null;

self.onmessage = (e: MessageEvent) => {
  const msg = e.data as InMsg;
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'initSharedTT') {
    tt = new TranspositionTable(msg.backing);
    const out: ReadyResponse = { type: 'ultraV2Ready' };
    self.postMessage(out);
    return;
  }

  if (msg.type === 'search') {
    if (!tt) return;

    const { board, player } = convertState(msg.state);
    const scores = normalizeScores(msg.state.scores);
    const scoreToWin = normalizeScoreToWin(msg.state.scoreToWin);
    const openingPreset = normalizeOpeningPreset(msg.state.openingPreset);
    const moveIndex = normalizeMoveIndex(msg.state.moveIndex);

    const rootMoveFilter = combineMoveFilters(
      getOpeningRootMoveFilter(openingPreset, moveIndex, player),
      noRiftFilterForOpening(openingPreset, moveIndex)
    );
    const ply1ReplyMoveFilter = combineMoveFilters(
      getOpeningPly1ReplyMoveFilter(openingPreset, moveIndex, player),
      noRiftFilterForOpening(openingPreset, moveIndex + 1)
    );
    const ply2MoveFilter = noRiftFilterForOpening(openingPreset, moveIndex + 2);

    // Diversify PV exploration by selecting a different high-priority root hint per worker.
    const allRootMoves = generateAllMoves(board, player, { scores, scoreToWin });
    const legalRootMoves = rootMoveFilter ? allRootMoves.filter(m => rootMoveFilter(m.move)) : allRootMoves;
    const K = Math.min(8, legalRootMoves.length);
    const hint = K > 0 ? legalRootMoves[msg.workerIndex % K]!.move : null;

    const remaining = msLeft(msg.deadlineMs);
    const timeLimit = Math.max(1, remaining);
    const result = findBestMove(
      board,
      player,
      timeLimit,
      msg.maxDepth,
      null,
      rootMoveFilter,
      ply1ReplyMoveFilter,
      ply2MoveFilter,
      scores,
      scoreToWin,
      {
        tt,
        preserveMoveOrdering: false,
        rootMoveHint: hint,
      }
    );

    const out: SearchResponse = {
      type: 'ultraV2Result',
      requestId: msg.requestId,
      completed: Boolean(result.completed),
      move: result.move ?? null,
      score: Number.isFinite(result.score) ? result.score : 0,
      depth: Number.isFinite(result.depth) ? (result.depth ?? 0) : 0,
      nodes: Number.isFinite(result.nodes) ? (result.nodes ?? 0) : 0,
    };
    self.postMessage(out);
  }
};

export {};

