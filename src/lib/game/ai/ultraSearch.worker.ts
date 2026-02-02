/**
 * UltraThink sub-worker
 *
 * Evaluates a subset of root moves by running session-based searches on the child positions
 * until an absolute deadline. This worker is designed to be spawned in a pool.
 */
import {
  boardFrom2D,
  cloneBoard,
  createSearchSession,
  getOpponent,
  makeMove,
  BLACK,
  WHITE,
  CONFIG,
  BOARD_SIZE,
} from './index';
import type { Board, Color, Move } from './types';
import type { SearchSession } from './search';
import { applyScoringAndClear } from './board';
import { TranspositionTable } from './transposition';
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

interface AnalyzeRootMovesRequest {
  type: 'analyzeRootMoves';
  state: WorkerState;
  rootMoves: Move[];
  maxDepth: number;
  deadlineMs: number;
  ttSize: number;
}

interface AnalyzeRootMovesResult {
  type: 'analyzeRootMovesResult';
  best: {
    move: Move;
    score: number; // from root player's perspective
    depth: number; // bestDepth reached in child search (plies)
    nodes: number;
  } | null;
  totalNodes: number; // total nodes searched across ALL sessions in this worker
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

function convertState(state: WorkerState): { board: Board; player: Color; scores: { black: number; white: number }; scoreToWin: number } {
  let koPosition: number | null = null;
  if (state.lastRiftedPosition) {
    koPosition = state.lastRiftedPosition.row * BOARD_SIZE + state.lastRiftedPosition.col;
  }
  const board = boardFrom2D(state.board, koPosition);
  const player: Color = state.playerToMove === 'black' ? BLACK : WHITE;
  const scores = normalizeScores(state.scores);
  const scoreToWin = normalizeScoreToWin(state.scoreToWin);
  return { board, player, scores, scoreToWin };
}

function msLeft(deadlineMs: number): number {
  return deadlineMs - Date.now();
}

function pickBetter(
  a: { move: Move; score: number; depth: number; nodes: number } | null,
  b: { move: Move; score: number; depth: number; nodes: number } | null
): { move: Move; score: number; depth: number; nodes: number } | null {
  if (!a) return b;
  if (!b) return a;
  // Prefer higher score; tie-break by depth.
  // Depth-first selection can pick "easy to search but bad" moves over better ones.
  if (b.score !== a.score) return b.score > a.score ? b : a;
  if (b.depth !== a.depth) return b.depth > a.depth ? b : a;
  return a;
}

self.onmessage = (e: MessageEvent) => {
  const req = e.data as AnalyzeRootMovesRequest;
  if (req.type !== 'analyzeRootMoves') return;

  void (async () => {
    const { board: rootBoard, player: rootPlayer, scores: rootScores, scoreToWin } = convertState(req.state);
    const opponent = getOpponent(rootPlayer);
    const maxDepth = req.maxDepth;
    const deadlineMs = req.deadlineMs;

    const tt = new TranspositionTable(req.ttSize);
    const nnueWeights = null;

    // Long Pro lookahead: if root is White on moveIndex=1, Black's immediate reply (moveIndex=2)
    // is restricted outside the center region. Apply that as the root filter for each child session.
    const openingPreset = normalizeOpeningPreset(req.state.openingPreset);
    const moveIndex = normalizeMoveIndex(req.state.moveIndex);
    const replyRootFilter = getOpeningPly1ReplyMoveFilter(openingPreset, moveIndex, rootPlayer);
    const childMoveIndex = moveIndex + 1;
    const childRootFilter = combineMoveFilters(
      replyRootFilter,
      noRiftFilterForOpening(openingPreset, childMoveIndex)
    );
    const childPly1Filter = noRiftFilterForOpening(openingPreset, childMoveIndex + 1);

    // Prepare one child session per root move.
    const sessions: Array<{
      rootMove: Move;
      immediate: { score: number; depth: number } | null;
      session: SearchSession | null;
      nodes: number;
    }> = [];

    for (const mv of req.rootMoves) {
      const child = cloneBoard(rootBoard);
      makeMove(child, mv, rootPlayer);

      const childScores = { ...rootScores };
      const scoring = applyScoringAndClear(child, mv, rootPlayer);
      if (scoring.scoredBy === BLACK) childScores.black += scoring.points;
      else if (scoring.scoredBy === WHITE) childScores.white += scoring.points;

      const matchWinner =
        scoreToWin !== 0 && (childScores.black >= scoreToWin || childScores.white >= scoreToWin)
          ? (childScores.black >= scoreToWin ? BLACK : WHITE)
          : null;

      if (matchWinner !== null) {
        const score = matchWinner === rootPlayer ? CONFIG.WIN_SCORE : CONFIG.LOSS_SCORE;
        sessions.push({ rootMove: mv, immediate: { score, depth: 1 }, session: null, nodes: 0 });
        continue;
      }

      const session = createSearchSession(
        child,
        opponent,
        maxDepth,
        tt,
        nnueWeights,
        childRootFilter,
        childPly1Filter,
        null,
        childScores,
        scoreToWin
      );
      sessions.push({ rootMove: mv, immediate: null, session, nodes: 0 });
    }

    let best: { move: Move; score: number; depth: number; nodes: number } | null = null;
    let totalNodes = 0;

    // Immediate wins/losses first.
    for (const s of sessions) {
      if (!s.immediate) continue;
      best = pickBetter(best, { move: s.rootMove, score: s.immediate.score, depth: s.immediate.depth, nodes: 0 });
      if (best && best.score >= CONFIG.WIN_SCORE - 100) break;
    }

    // Session-based proof-ish loop: deepen all child sessions in round-robin slices until deadline.
    const sliceFloor = 20;
    while (msLeft(deadlineMs) > 0) {
      let anyActive = false;

      for (const s of sessions) {
        if (!s.session) continue;
        if (msLeft(deadlineMs) <= 0) break;

        anyActive = true;
        const remaining = msLeft(deadlineMs);
        const sliceMs = Math.max(sliceFloor, Math.min(250, remaining));

        const r = s.session.searchSlice(sliceMs);
        const sliceNodes = r.nodes ?? 0;
        s.nodes += sliceNodes;
        totalNodes += sliceNodes;

        const childDepth = r.depth ?? 0;
        const rootScore = -r.score; // negate: child score is opponent-perspective
        best = pickBetter(best, { move: s.rootMove, score: rootScore, depth: childDepth, nodes: s.nodes });

        // Early out if we proved a win at any depth.
        if (best && best.score >= CONFIG.WIN_SCORE - 100) break;

        // Yield within the worker to remain responsive.
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }

      if (!anyActive) break;
      if (best && best.score >= CONFIG.WIN_SCORE - 100) break;
    }

    const out: AnalyzeRootMovesResult = { type: 'analyzeRootMovesResult', best, totalNodes };
    self.postMessage(out);
  })();
};

export {};

