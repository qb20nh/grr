/**
 * UltraThink root-PVS sub-worker
 *
 * Attaches to a SharedArrayBuffer-backed transposition table and evaluates
 * individual root moves via fixed-depth, windowed alpha-beta.
 */
import {
  alphaBetaWindowed,
  BOARD_SIZE,
  boardFrom2D,
  cloneBoard,
  getOpponent,
  makeMove,
  BLACK,
  WHITE,
  CONFIG,
  TranspositionTable,
} from './index';
import type { Board, Color, Move } from './types';
import { applyScoringAndClear } from './board';
import type { SharedTranspositionTableBacking } from './transposition';
import type { OpeningPreset } from '../types';
import { getOpeningPly1ReplyMoveFilter } from './openingFilters';
import { LONG_PRO_RIFT_FORBIDDEN_FIRST_TURNS } from '../riftRules';

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
  scores?: { black: number; white: number };
  scoreToWin?: number;
  openingPreset?: OpeningPreset;
  moveIndex?: number;
}

interface InitSharedTTRequest {
  type: 'initSharedTT';
  backing: SharedTranspositionTableBacking;
}

interface SetPositionRequest {
  type: 'setPosition';
  state: WorkerState;
}

interface SearchRootMoveRequest {
  type: 'searchRootMove';
  requestId: number;
  rootMove: Move;
  depth: number;
  alpha: number;
  beta: number;
  deadlineMs: number;
}

type InMsg = InitSharedTTRequest | SetPositionRequest | SearchRootMoveRequest;

interface ReadyResponse {
  type: 'ultraPvsReady';
}

interface PositionReadyResponse {
  type: 'ultraPvsPositionReady';
}

interface SearchRootMoveResponse {
  type: 'searchRootMoveResult';
  requestId: number;
  rootMove: Move;
  completed: boolean;
  score: number; // from root player's perspective
  depth: number; // requested depth (plies from root)
  nodes: number;
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

let tt: TranspositionTable | null = null;
let rootBoard: Board | null = null;
let rootPlayer: Color | null = null;
let rootScores: { black: number; white: number } = { black: 0, white: 0 };
let rootScoreToWin = 1;
let replyRootMoveFilter: ((m: Move) => boolean) | null = null;
let replyPly1MoveFilter: ((m: Move) => boolean) | null = null;

function msLeft(deadlineMs: number): number {
  return deadlineMs - Date.now();
}

self.onmessage = (e: MessageEvent) => {
  const msg = e.data as InMsg;

  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'initSharedTT') {
    tt = new TranspositionTable(msg.backing);
    const out: ReadyResponse = { type: 'ultraPvsReady' };
    self.postMessage(out);
    return;
  }

  if (msg.type === 'setPosition') {
    const { board, player } = convertState(msg.state);
    rootBoard = board;
    rootPlayer = player;
    rootScores = normalizeScores(msg.state.scores);
    rootScoreToWin = normalizeScoreToWin(msg.state.scoreToWin);
    // Long Pro lookahead: when root is White on moveIndex=1, Black's immediate reply (moveIndex=2)
    // is restricted outside the center region. Apply that restriction as the root filter for the
    // child search we run after each root move.
    const openingPreset = normalizeOpeningPreset(msg.state.openingPreset);
    const moveIndex = normalizeMoveIndex(msg.state.moveIndex);
    const childMoveIndex = moveIndex + 1;
    replyRootMoveFilter = combineMoveFilters(
      getOpeningPly1ReplyMoveFilter(openingPreset, moveIndex, player),
      noRiftFilterForOpening(openingPreset, childMoveIndex)
    );
    replyPly1MoveFilter = noRiftFilterForOpening(openingPreset, childMoveIndex + 1);
    const out: PositionReadyResponse = { type: 'ultraPvsPositionReady' };
    self.postMessage(out);
    return;
  }

  if (msg.type === 'searchRootMove') {
    if (!tt || !rootBoard || !rootPlayer) {
      return;
    }

    const remaining = msLeft(msg.deadlineMs);
    if (remaining <= 0) {
      const out: SearchRootMoveResponse = {
        type: 'searchRootMoveResult',
        requestId: msg.requestId,
        rootMove: msg.rootMove,
        completed: false,
        score: 0,
        depth: msg.depth,
        nodes: 0,
      };
      self.postMessage(out);
      return;
    }

    const depth = Math.max(1, Math.floor(msg.depth));
    const child = cloneBoard(rootBoard);
    makeMove(child, msg.rootMove, rootPlayer);

    const childScores = { ...rootScores };
    const scoring = applyScoringAndClear(child, msg.rootMove, rootPlayer);
    if (scoring.scoredBy === BLACK) childScores.black += scoring.points;
    else if (scoring.scoredBy === WHITE) childScores.white += scoring.points;

    const matchWinner =
      rootScoreToWin !== 0 && (childScores.black >= rootScoreToWin || childScores.white >= rootScoreToWin)
        ? (childScores.black >= rootScoreToWin ? BLACK : WHITE)
        : null;

    if (matchWinner !== null) {
      const score = matchWinner === rootPlayer ? CONFIG.WIN_SCORE : CONFIG.LOSS_SCORE;
      const out: SearchRootMoveResponse = {
        type: 'searchRootMoveResult',
        requestId: msg.requestId,
        rootMove: msg.rootMove,
        completed: true,
        score,
        depth,
        nodes: 1,
      };
      self.postMessage(out);
      return;
    }

    const opponent = getOpponent(rootPlayer);
    const childDepth = Math.max(0, depth - 1);
    const timeLimitMs = Math.max(1, remaining);

    const r = alphaBetaWindowed(
      child,
      opponent,
      childDepth,
      -msg.beta,
      -msg.alpha,
      timeLimitMs,
      tt,
      null,
      // Passing the root move as prevMove lets countermove/continuation history order replies.
      msg.rootMove,
      replyRootMoveFilter,
      replyPly1MoveFilter,
      null,
      childScores,
      rootScoreToWin
    );

    const out: SearchRootMoveResponse = {
      type: 'searchRootMoveResult',
      requestId: msg.requestId,
      rootMove: msg.rootMove,
      completed: r.completed,
      score: -r.score,
      depth,
      nodes: r.nodes ?? 0,
    };
    self.postMessage(out);
    return;
  }
};

export {};

