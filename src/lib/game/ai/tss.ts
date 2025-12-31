/**
 * Threat Space Search (TSS)
 * A tactical prover that searches forcing threat chains (VCT/VCF-style),
 * adapted to Gomoku Rift's reinforce/rift + Ko + exact-5 rule.
 *
 * This is intentionally conservative: it only returns a move when it can
 * actually PROVE a forced win (within the given ply/time limits).
 */

import type { Board, CellIndex, Color, Move } from './types';
import { createReinforceMove, createRiftMove, createSingleWinMove, getOpponent } from './utils';
import { makeMove, unmakeMove, validateReinforce } from './board';
import { scanLine, classifyLine } from './patterns';
import { getSingleStoneWinningSquares } from './threats';
import { withTurn } from './zobrist';
import { getCandidatePositions, scoreCandidates } from './moveGen';
import { decodeMove, encodeMove, MOVE_CODE_NONE } from './moveCodec';

type TssStatus = 'proven_win' | 'not_proven' | 'timeout';

export interface TssResult {
  status: TssStatus;
  /** Recommended move for the side-to-move at the root (only meaningful for proven_win / defender refutation). */
  move: Move | null;
  /** Principal variation for a proven line (includes `move` as first entry). */
  pv: Move[];
  nodes: number;
}

export interface TssOptions {
  timeLimitMs: number;
  maxPlies: number;
  maxAttackerMoves: number;
  maxDefenderMoves: number;
}

const DEFAULT_TSS_OPTIONS: TssOptions = {
  timeLimitMs: 1500,
  maxPlies: 10,
  maxAttackerMoves: 16,
  maxDefenderMoves: 24,
};

interface MemoEntry {
  status: TssStatus;
  bestMoveCode: number; // -1 if none
}

const MOVE_NONE = MOVE_CODE_NONE;

// Cross-call cache for root results (keyed by position hash + turn + attacker + limits).
// This is intentionally small/cheap; TT remains the main cache.
const ROOT_CACHE_MAX = 20000;
const rootCache = new Map<bigint, MemoEntry>();

// Prefer sensible filler squares near the main action when a defender must play a forced block
// and the second stone is otherwise unconstrained. This prevents “corner garbage” placements.
const CENTER_FIRST: readonly CellIndex[] = (() => {
  const out: CellIndex[] = Array.from({ length: 225 }, (_, i) => i);
  const center = 7;
  out.sort((a, b) => {
    const ar = Math.floor(a / 15);
    const ac = a % 15;
    const br = Math.floor(b / 15);
    const bc = b % 15;
    const da = Math.abs(ar - center) + Math.abs(ac - center);
    const db = Math.abs(br - center) + Math.abs(bc - center);
    if (da !== db) return da - db;
    return a - b;
  });
  return out;
})();

function memoKey(board: Board, attacker: Color, toMove: Color, pliesLeft: number): bigint {
  // Include turn + attacker + remaining depth.
  // We keep it as BigInt for cheap hashing without string allocations.
  let key = withTurn(board.hash, toMove);
  key = (key << 6n) ^ BigInt(pliesLeft & 0x3f);
  key = (key << 2n) ^ BigInt(attacker); // attacker is 1 or 2
  return key;
}

function rootKey(board: Board, attacker: Color, toMove: Color, options: TssOptions): bigint {
  let key = withTurn(board.hash, toMove);
  key = (key << 6n) ^ BigInt(options.maxPlies & 0x3f);
  key = (key << 6n) ^ BigInt(options.maxAttackerMoves & 0x3f);
  key = (key << 6n) ^ BigInt(options.maxDefenderMoves & 0x3f);
  key = (key << 2n) ^ BigInt(attacker);
  return key;
}

/**
 * Compute immediate winning squares for `player` (i.e., where a single stone would win).
 * This avoids scanning all empties by detecting 4-threat patterns from existing stones.
 */
function getImmediateWinSquares(
  board: Board,
  player: Color,
  koMode: 'respectKo' | 'ignoreKo' = 'respectKo'
): CellIndex[] {
  return getSingleStoneWinningSquares(board, player, koMode);
}

/**
 * If a rift removes a stone of `removedColor`, it can create an immediate win for `removedColor`
 * by trimming an overline down to exactly 5. We only need to inspect lines passing through `riftPos`.
 */
function riftCreatesWinForRemovedColor(board: Board, riftPos: CellIndex, removedColor: Color): boolean {
  const row = Math.floor(riftPos / 15);
  const col = riftPos % 15;

  const dirs: readonly [number, number][] = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ];

  for (const [dr, dc] of dirs) {
    // Count contiguous stones starting adjacent to the removed cell in each direction.
    let f = 0;
    let r = row + dr;
    let c = col + dc;
    while (r >= 0 && r < 15 && c >= 0 && c < 15 && board.cells[r * 15 + c] === removedColor) {
      f++;
      r += dr;
      c += dc;
    }

    let b = 0;
    r = row - dr;
    c = col - dc;
    while (r >= 0 && r < 15 && c >= 0 && c < 15 && board.cells[r * 15 + c] === removedColor) {
      b++;
      r -= dr;
      c -= dc;
    }

    // The removed cell splits the line; either side segment could now be exactly 5.
    if (f === 5 || b === 5) return true;
  }

  return false;
}

function generateForcingAttackerMoves(board: Board, attacker: Color, limit: number): Move[] {
  const defender = getOpponent(attacker);
  const moves: Move[] = [];

  // 1) Rift candidates (attacker-side tactic): removing a defender stone can create a Ko-locked
  // winning square the defender can't occupy immediately.
  //
  // We keep this bounded by only considering defender stones near attacker stones.
  const riftTargets: { pos: CellIndex; score: number }[] = [];
  for (let pos = 0; pos < 225; pos++) {
    if (board.cells[pos] !== defender) continue;

    const row = Math.floor(pos / 15);
    const col = pos % 15;

    let adjacentAttackers = 0;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const r = row + dr;
        const c = col + dc;
        if (r < 0 || r >= 15 || c < 0 || c >= 15) continue;
        if (board.cells[r * 15 + c] === attacker) adjacentAttackers++;
      }
    }

    if (adjacentAttackers > 0) {
      riftTargets.push({ pos, score: adjacentAttackers });
    }
  }

  riftTargets.sort((a, b) => b.score - a.score);
  const riftQuota = Math.min(limit, 6);
  for (let i = 0; i < riftTargets.length && moves.length < riftQuota; i++) {
    moves.push(createRiftMove(riftTargets[i].pos));
  }

  // 2) Reinforce candidates: pair top empty squares (Ko-aware).
  const candidates = scoreCandidates(board, getCandidatePositions(board), attacker);
  const top = candidates.slice(0, Math.min(18, candidates.length));

  // Pair top candidates (ordered by single-position score)
  for (let i = 0; i < top.length && moves.length < limit; i++) {
    for (let j = i + 1; j < top.length && moves.length < limit; j++) {
      const a = top[i].pos;
      const b = top[j].pos;
      if (!validateReinforce(board, a, b, attacker)) continue;
      moves.push(createReinforceMove(a, b));
    }
  }

  return moves;
}

function generateDefenderReplies(
  board: Board,
  attacker: Color,
  defender: Color,
  threatSquares: CellIndex[],
  limit: number
): { replies: Move[]; complete: boolean } {
  const replies: Move[] = [];
  const threatSet = new Set<CellIndex>(threatSquares);

  // 1) Reinforce replies: occupy ALL current immediate win squares.
  // - If there are 2+ threat squares, defender must cover them all (or lose immediately).
  // - If there is exactly 1 threat square, defender must place there, but can choose any
  //   legal second stone; enumerate all legal pairings (bounded by `limit`).
  if (threatSquares.length === 2) {
    const a = threatSquares[0];
    const b = threatSquares[1];
    if (validateReinforce(board, a, b, defender)) {
      replies.push(createReinforceMove(a, b));
    }
  } else if (threatSquares.length === 1) {
    const block = threatSquares[0];
    // Try good local fillers first (near existing stones), then fall back to a center-first sweep.
    const preferred = scoreCandidates(board, getCandidatePositions(board), defender)
      .slice(0, 32)
      .map(s => s.pos);

    const seen = new Set<CellIndex>();
    for (const f of preferred) {
      if (f === block) continue;
      if (seen.has(f)) continue;
      seen.add(f);
      if (!validateReinforce(board, block, f, defender)) continue;
      replies.push(createReinforceMove(block, f));
      if (replies.length >= limit) return { replies, complete: false };
    }

    for (const f of CENTER_FIRST) {
      if (f === block) continue;
      if (seen.has(f)) continue;
      seen.add(f);
      if (!validateReinforce(board, block, f, defender)) continue;
      replies.push(createReinforceMove(block, f));
      if (replies.length >= limit) return { replies, complete: false };
    }
  }

  // 2) Rift replies: remove attacker stones that participate in the immediate-win patterns
  // that create these threat squares. This is complete for the “single-stone win square” model.
  const riftCandidates = new Set<CellIndex>();
  for (let pos = 0; pos < 225; pos++) {
    if (board.cells[pos] !== attacker) continue;

    for (let dir = 0; dir < 4; dir++) {
      // Threat squares are computed with Ko ignored (attacker moves after Ko clears/changes),
      // so pattern detection here must also treat Ko as open.
      const info = scanLine(board, pos, dir, attacker, true);
      const pattern = classifyLine(info);

      let hits = false;
      if (pattern === 'OPEN_FOUR' || pattern === 'HALF_FOUR') {
        if (info.extendCount >= 1 && threatSet.has(info.extend1)) hits = true;
        else if (info.extendCount >= 2 && threatSet.has(info.extend2)) hits = true;
      } else if (pattern === 'GAP_FOUR') {
        if (info.gaps === 1 && threatSet.has(info.gapPos)) hits = true;
      } else {
        continue;
      }

      if (hits) {
        riftCandidates.add(pos);
        break;
      }
    }
  }

  for (const pos of riftCandidates) {
    replies.push(createRiftMove(pos));
    if (replies.length >= limit) {
      return { replies, complete: false };
    }
  }

  return { replies, complete: true };
}

/**
 * Main entry: attempt to prove a forced win for `attacker` with `toMove` to play.
 *
 * - If `toMove === attacker`, a `proven_win` returns an attacking first move.
 * - If `toMove !== attacker`, a `not_proven` may return a defender refutation move.
 */
export function threatSpaceSearch(
  board: Board,
  attacker: Color,
  toMove: Color,
  opts: Partial<TssOptions> = {}
): TssResult {
  const options: TssOptions = { ...DEFAULT_TSS_OPTIONS, ...opts };
  const start = Date.now();
  const deadline = start + Math.max(1, options.timeLimitMs);

  const rKey = rootKey(board, attacker, toMove, options);
  const cachedRoot = rootCache.get(rKey);
  if (cachedRoot && cachedRoot.status !== 'timeout') {
    return {
      status: cachedRoot.status,
      move: decodeMove(cachedRoot.bestMoveCode),
      pv: [],
      nodes: 0,
    };
  }

  const memo = new Map<bigint, MemoEntry>();
  let nodes = 0;

  const defender = getOpponent(attacker);

  function timeUp(): boolean {
    return Date.now() >= deadline;
  }

  function dfs(currentToMove: Color, pliesLeft: number): TssResult {
    nodes++;

    if (timeUp()) {
      return { status: 'timeout', move: null, pv: [], nodes };
    }

    if (pliesLeft <= 0) {
      return { status: 'not_proven', move: null, pv: [], nodes };
    }

    const key = memoKey(board, attacker, currentToMove, pliesLeft);
    const cached = memo.get(key);
    if (cached) {
      return {
        status: cached.status,
        move: decodeMove(cached.bestMoveCode),
        pv: [],
        nodes,
      };
    }

    // Immediate win check (single-stone rule).
    const winSquaresNow = getImmediateWinSquares(board, currentToMove, 'respectKo');
    if (winSquaresNow.length > 0) {
      const winMove = createSingleWinMove(winSquaresNow[0]);
      const status: TssStatus = currentToMove === attacker ? 'proven_win' : 'not_proven';
      const result: TssResult = { status, move: winMove, pv: [winMove], nodes };
      memo.set(key, { status, bestMoveCode: encodeMove(winMove) });
      return result;
    }

    if (currentToMove === attacker) {
      // Attacker node (OR): try to find a forcing move that leads to a proven win.
      const candidates = generateForcingAttackerMoves(board, attacker, options.maxAttackerMoves);

      let sawTimeout = false;

      for (const mv of candidates) {
        const undo = makeMove(board, mv, attacker);

        // Rift guard: never allow an attacker rift that immediately gives the removed color an exact-5.
        if (mv.action === 'rift') {
          if (riftCreatesWinForRemovedColor(board, mv.pos, defender)) {
            unmakeMove(board, undo, attacker);
            continue;
          }
        }

        // Forcing requirement: attacker must threaten an immediate win on their next turn.
        // Important: the current Ko will clear/replace on the defender's reply, so compute
        // these threat squares with Ko ignored.
        const threats = getImmediateWinSquares(board, attacker, 'ignoreKo');
        if (threats.length === 0) {
          unmakeMove(board, undo, attacker);
          continue;
        }

        const child = dfs(defender, pliesLeft - 1);
        unmakeMove(board, undo, attacker);

        if (child.status === 'timeout') {
          sawTimeout = true;
          continue;
        }

        if (child.status === 'proven_win') {
          const pv = [mv, ...child.pv];
          const res: TssResult = { status: 'proven_win', move: mv, pv, nodes };
          memo.set(key, { status: 'proven_win', bestMoveCode: encodeMove(mv) });
          return res;
        }
      }

      const status: TssStatus = sawTimeout ? 'timeout' : 'not_proven';
      memo.set(key, { status, bestMoveCode: MOVE_NONE });
      return { status, move: null, pv: [], nodes };
    }

    // Defender node (AND): generate forced replies that eliminate all attacker immediate wins.
    const attackerThreatSquares = getImmediateWinSquares(board, attacker, 'ignoreKo');
    if (attackerThreatSquares.length === 0) {
      // No immediate threat to respond to; within threat-space this means no proof continuation.
      memo.set(key, { status: 'not_proven', bestMoveCode: MOVE_NONE });
      return { status: 'not_proven', move: null, pv: [], nodes };
    }

    const { replies, complete } = generateDefenderReplies(
      board,
      attacker,
      currentToMove,
      attackerThreatSquares,
      options.maxDefenderMoves
    );

    if (replies.length === 0) {
      // Defender cannot eliminate the immediate win threats => forced win for attacker.
      memo.set(key, { status: 'proven_win', bestMoveCode: MOVE_NONE });
      return { status: 'proven_win', move: null, pv: [], nodes };
    }

    let sawTimeout = false;

    for (const reply of replies) {
      const undo = makeMove(board, reply, currentToMove);

      // For rift replies: ensure we didn't accidentally hand the attacker a win by trimming overline.
      if (reply.action === 'rift') {
        if (riftCreatesWinForRemovedColor(board, reply.pos, attacker)) {
          unmakeMove(board, undo, currentToMove);
          continue;
        }
      }

      // Reply must actually eliminate immediate win threats; otherwise attacker wins next move.
      const stillThreatSquares = getImmediateWinSquares(board, attacker, 'respectKo');
      if (stillThreatSquares.length > 0) {
        unmakeMove(board, undo, currentToMove);
        continue;
      }

      const child = dfs(attacker, pliesLeft - 1);
      unmakeMove(board, undo, currentToMove);

      if (child.status === 'timeout') {
        sawTimeout = true;
        continue;
      }

      if (child.status !== 'proven_win') {
        // Defender found a refutation (attacker not proven).
        memo.set(key, { status: 'not_proven', bestMoveCode: encodeMove(reply) });
        return { status: 'not_proven', move: reply, pv: [], nodes };
      }
    }

    // All explored defenses lead to a proven attacker win.
    // Only claim proven_win if our defender reply set is complete and we did not hit timeouts.
    if (sawTimeout || !complete) {
      memo.set(key, { status: 'timeout', bestMoveCode: MOVE_NONE });
      return { status: 'timeout', move: null, pv: [], nodes };
    }

    memo.set(key, { status: 'proven_win', bestMoveCode: MOVE_NONE });
    return { status: 'proven_win', move: null, pv: [], nodes };
  }

  // Iterative deepening within the time slice: deepen in even plies (full attacker/defender pairs),
  // returning the best non-timeout result from the deepest completed iteration.
  let best: TssResult = { status: 'not_proven', move: null, pv: [], nodes: 0 };
  let completedPlies = 0;
  for (let plies = 2; plies <= options.maxPlies; plies += 2) {
    const res = dfs(toMove, plies);
    if (res.status === 'timeout') break;
    best = res;
    completedPlies = plies;
    if (best.status === 'proven_win') break;
  }

  // Ensure nodes/time are consistent on the returned object.
  const out: TssResult = {
    ...best,
    nodes,
  };

  // Cache root result across calls only when we actually completed the requested depth,
  // or when we found a proven win earlier (safe to reuse).
  const canCache = out.status !== 'timeout' && (completedPlies === options.maxPlies || out.status === 'proven_win');
  if (canCache) {
    if (rootCache.size >= ROOT_CACHE_MAX) rootCache.clear();
    rootCache.set(rKey, { status: out.status, bestMoveCode: encodeMove(out.move) });
  }

  return out;
}


