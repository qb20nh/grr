/**
 * Threat Space Search (TSS)
 * A tactical prover that searches forcing threat chains (VCT/VCF-style),
 * adapted to Gomoku Rift's reinforce/rift + Ko + exact-5 rule.
 *
 * This is intentionally conservative: it only returns a move when it can
 * actually PROVE a forced win (within the given ply/time limits).
 */

import type { Board, CellIndex, Color, Move } from './types';
import { createReinforceMove, createRiftMove, createSingleWinMove, getOpponent, isSingleWinMove } from './utils';
import { makeMove, unmakeMove, checkWinAt, validateReinforce } from './board';
import { scanLine, classifyLine } from './patterns';
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
function getImmediateWinSquares(board: Board, player: Color): CellIndex[] {
  const wins = new Set<CellIndex>();

  for (let pos = 0; pos < 225; pos++) {
    if (board.cells[pos] !== player) continue;

    for (let dir = 0; dir < 4; dir++) {
      const info = scanLine(board, pos, dir, player);
      const pattern = classifyLine(info);

      if (pattern === 'OPEN_FOUR' || pattern === 'HALF_FOUR') {
        for (const e of info.extendPositions) wins.add(e);
      } else if (pattern === 'GAP_FOUR') {
        for (const g of info.gapPositions) wins.add(g);
      }
    }
  }

  return Array.from(wins);
}

function getImmediateWinningMoves(board: Board, player: Color, limit: number): Move[] {
  const moves: Move[] = [];

  // 1) Single-stone wins (special rule).
  const singleWins = getImmediateWinSquares(board, player);
  for (const w of singleWins) {
    moves.push(createSingleWinMove(w));
    if (moves.length >= limit) return moves;
  }

  // 2) Two-stone immediate wins (normal reinforce move).
  // Bounded pairing over top candidate squares to keep this fast.
  const candidates = scoreCandidates(board, getCandidatePositions(board), player)
    .slice(0, 18)
    .map(s => s.pos);

  // Try higher-value pairs first.
  for (let i = 0; i < candidates.length && moves.length < limit; i++) {
    for (let j = i + 1; j < candidates.length && moves.length < limit; j++) {
      const a = candidates[i];
      const b = candidates[j];
      if (!validateReinforce(board, a, b, player)) continue;

      const mv = createReinforceMove(a, b);
      const undo = makeMove(board, mv, player);
      const win = winsAfterReinforce(board, player, mv);
      unmakeMove(board, undo, player);

      if (win) {
        moves.push(mv);
      }
    }
  }

  return moves;
}

function collectThreatSquares(threatMoves: Move[]): CellIndex[] {
  const s = new Set<CellIndex>();
  for (const mv of threatMoves) {
    if (mv.action !== 'reinforce') continue;
    s.add(mv.pos1);
    if (!isSingleWinMove(mv)) s.add(mv.pos2);
  }
  return Array.from(s);
}

function winsAfterReinforce(board: Board, player: Color, move: Move): boolean {
  if (move.action !== 'reinforce') return false;
  if (checkWinAt(board, move.pos1, player)) return true;
  if (!isSingleWinMove(move) && checkWinAt(board, move.pos2, player)) return true;
  return false;
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
  // Use existing candidate generation (already Ko-aware) and filter to forcing reinforce moves.
  const candidates = scoreCandidates(board, getCandidatePositions(board), attacker);
  const top = candidates.slice(0, Math.min(18, candidates.length));

  const moves: Move[] = [];

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
): Move[] {
  const replies: Move[] = [];

  const threatSet = new Set<CellIndex>(threatSquares);

  // 1) Rift replies: try removing attacker stones that participate in threat patterns.
  // We keep this conservative by only rifting stones on lines that yield threat squares.
  const riftCandidates = new Set<CellIndex>();
  for (let pos = 0; pos < 225; pos++) {
    if (board.cells[pos] !== attacker) continue;

    for (let dir = 0; dir < 4; dir++) {
      const info = scanLine(board, pos, dir, attacker);
      const pattern = classifyLine(info);
      // Include OPEN_THREE / GAP_THREE because in two-stone reinforce they can be one-move wins.
      if (
        pattern !== 'OPEN_FOUR' &&
        pattern !== 'HALF_FOUR' &&
        pattern !== 'GAP_FOUR' &&
        pattern !== 'OPEN_THREE' &&
        pattern !== 'GAP_THREE'
      ) continue;

      const wins: CellIndex[] =
        (pattern === 'GAP_FOUR' || pattern === 'GAP_THREE') ? info.gapPositions : info.extendPositions;
      if (wins.some(w => threatSet.has(w))) {
        riftCandidates.add(pos);
        break;
      }
    }
  }

  for (const pos of riftCandidates) {
    replies.push(createRiftMove(pos));
    if (replies.length >= limit) return replies;
  }

  // 2) Reinforce replies: place on threat squares (and another legal filler) to eliminate all threats.
  const filler = scoreCandidates(board, getCandidatePositions(board), defender)
    .slice(0, 12)
    .map(s => s.pos);

  const block = threatSquares.slice(0, 8); // keep bounded

  for (const b1 of block) {
    // Prefer blocking with another threat square if possible.
    for (const b2 of block) {
      if (b2 <= b1) continue;
      if (!validateReinforce(board, b1, b2, defender)) continue;
      replies.push(createReinforceMove(b1, b2));
      if (replies.length >= limit) return replies;
    }

    // Otherwise block one + filler
    for (const f of filler) {
      if (f === b1) continue;
      if (!validateReinforce(board, b1, f, defender)) continue;
      replies.push(createReinforceMove(b1, f));
      if (replies.length >= limit) return replies;
    }
  }

  return replies;
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

    // Immediate win check (single-stone rule OR two-stone reinforce win)
    const immediateWins = getImmediateWinningMoves(board, currentToMove, 1);
    if (immediateWins.length > 0) {
      const winMove = immediateWins[0];
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

        // If this move directly wins (should be rare with single-win rule), we are done.
        if (winsAfterReinforce(board, attacker, mv)) {
          unmakeMove(board, undo, attacker);
          const res: TssResult = { status: 'proven_win', move: mv, pv: [mv], nodes };
          memo.set(key, { status: 'proven_win', bestMoveCode: encodeMove(mv) });
          return res;
        }

        // Forcing requirement: attacker must threaten an immediate win next ply.
        const threats = getImmediateWinningMoves(board, attacker, 2);
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
    const attackerThreatMoves = getImmediateWinningMoves(board, attacker, 10);
    if (attackerThreatMoves.length === 0) {
      // No immediate threat to respond to; within threat-space this means no proof continuation.
      memo.set(key, { status: 'not_proven', bestMoveCode: MOVE_NONE });
      return { status: 'not_proven', move: null, pv: [], nodes };
    }

    const attackerThreatSquares = collectThreatSquares(attackerThreatMoves);

    const replies = generateDefenderReplies(
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
    let bestRefutation: Move | null = null;

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
      const stillThreats = getImmediateWinningMoves(board, attacker, 1);
      if (stillThreats.length > 0) {
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
        bestRefutation = reply;
        memo.set(key, { status: 'not_proven', bestMoveCode: encodeMove(reply) });
        return { status: 'not_proven', move: reply, pv: [], nodes };
      }
    }

    // All defenses lead to proven attacker win (within our threat space).
    const status: TssStatus = sawTimeout ? 'timeout' : 'proven_win';
    memo.set(key, { status, bestMoveCode: encodeMove(bestRefutation) });
    return { status, move: bestRefutation, pv: [], nodes };
  }

  const res = dfs(toMove, options.maxPlies);

  // Ensure nodes/time are consistent on the returned object.
  const out: TssResult = {
    ...res,
    nodes,
  };

  // Cache root result across calls (avoid caching timeouts).
  if (out.status !== 'timeout') {
    if (rootCache.size >= ROOT_CACHE_MAX) rootCache.clear();
    rootCache.set(rKey, { status: out.status, bestMoveCode: encodeMove(out.move) });
  }

  return out;
}


