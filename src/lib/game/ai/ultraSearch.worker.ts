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
  getWinnerAfterMove,
  makeMove,
  BLACK,
  WHITE,
  CONFIG,
  BOARD_SIZE,
} from './index';
import type { Board, Color, Move } from './types';
import type { SearchSession } from './search';
import type { NnueWeights } from './nnue/weights';
import { getBundledWeightsUrl, loadNnueWeightsOptional } from './nnue/weights';
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

function convertState(state: WorkerState): { board: Board; player: Color } {
  let koPosition: number | null = null;
  if (state.lastRiftedPosition) {
    koPosition = state.lastRiftedPosition.row * BOARD_SIZE + state.lastRiftedPosition.col;
  }
  const board = boardFrom2D(state.board, koPosition);
  const player: Color = state.playerToMove === 'black' ? BLACK : WHITE;
  return { board, player };
}

// ---- NNUE weights (optional, cached per worker) ----
let nnueWeightsPromise: Promise<NnueWeights | null> | null = null;
function getNnueWeights(): Promise<NnueWeights | null> {
  if (!nnueWeightsPromise) {
    nnueWeightsPromise = loadNnueWeightsOptional(getBundledWeightsUrl());
  }
  return nnueWeightsPromise;
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
  // Prefer deeper results; tie-break by score.
  if (b.depth !== a.depth) return b.depth > a.depth ? b : a;
  if (b.score !== a.score) return b.score > a.score ? b : a;
  return a;
}

self.onmessage = (e: MessageEvent) => {
  const req = e.data as AnalyzeRootMovesRequest;
  if (req.type !== 'analyzeRootMoves') return;

  void (async () => {
    const { board: rootBoard, player: rootPlayer } = convertState(req.state);
    const opponent = getOpponent(rootPlayer);
    const maxDepth = req.maxDepth;
    const deadlineMs = req.deadlineMs;

    const tt = new TranspositionTable(req.ttSize);
    const nnueWeights = await getNnueWeights();

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
      const undo = makeMove(child, mv, rootPlayer);
      const winner = getWinnerAfterMove(child, mv, rootPlayer);
      // No need to keep undo; child is dedicated.
      void undo;

      if (winner !== null) {
        const score = winner === rootPlayer ? CONFIG.WIN_SCORE : CONFIG.LOSS_SCORE;
        sessions.push({ rootMove: mv, immediate: { score, depth: 1 }, session: null, nodes: 0 });
        continue;
      }

      const session = createSearchSession(child, opponent, maxDepth, tt, nnueWeights, childRootFilter, childPly1Filter, null);
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

