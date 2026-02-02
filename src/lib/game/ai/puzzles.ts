/**
 * Tactical puzzle/regression harness for the AI engine.
 *
 * This is intentionally lightweight (no test framework). It can be invoked
 * from the AI worker in debug mode to sanity-check must-block / forced-win behavior.
 */

import type { Board as InternalBoard, Color, Move } from './types';
import { BLACK, WHITE } from './types';
import { boardFrom2D, cloneBoard, makeMove, unmakeMove, getWinnerAfterMove, validateReinforce } from './board';
import { findBestMove } from './search';
import { threatSpaceSearch } from './tss';
import { findWinningPositions } from './threats';
import { countPatterns } from './patterns';
import { generateAllMoves } from './moveGen';
import { toIndex, toPosition, isSingleWinMove } from './utils';

export interface PuzzleResult {
  name: string;
  ok: boolean;
  details?: string;
}

export interface PuzzleRunSummary {
  passed: number;
  failed: number;
  results: PuzzleResult[];
}

function emptyGrid(): (string | null)[][] {
  return Array.from({ length: 15 }, () => Array.from({ length: 15 }, () => null));
}

function place(grid: (string | null)[][], color: 'black' | 'white', row: number, col: number): void {
  grid[row][col] = color;
}

function applyLegacyReinforce(
  grid: (string | null)[][],
  color: 'black' | 'white',
  a: [number, number],
  b: [number, number]
): void {
  place(grid, color, a[0], a[1]);
  place(grid, color, b[0], b[1]);
}

function applyMove(board: InternalBoard, move: Move, player: Color): InternalBoard {
  const b = cloneBoard(board);
  makeMove(b, move, player);
  return b;
}

function hasImmediateWinningMove(board: InternalBoard, player: Color): boolean {
  const moves = generateAllMoves(board, player);
  for (const { move } of moves) {
    const undo = makeMove(board, move, player);
    const winner = getWinnerAfterMove(board, move, player);
    unmakeMove(board, undo, player);
    if (winner === player) return true;
  }
  return false;
}

interface Puzzle {
  name: string;
  toMove: Color;
  board: (string | null)[][];
  ko?: { row: number; col: number } | null;
  assert: (board: InternalBoard, move: Move) => { ok: boolean; details?: string };
}

export function runTacticalPuzzles(timeLimitMs: number = 250): PuzzleRunSummary {
  const puzzles: Puzzle[] = [
    {
      name: 'Immediate win: single-stone win is chosen',
      toMove: BLACK,
      board: (() => {
        const g = emptyGrid();
        // Black has XXXX_ horizontally at row 7, cols 3-6; winning at col 7.
        place(g, 'black', 7, 3);
        place(g, 'black', 7, 4);
        place(g, 'black', 7, 5);
        place(g, 'black', 7, 6);
        // Add a couple white stones elsewhere to avoid empty-board heuristics.
        place(g, 'white', 6, 6);
        place(g, 'white', 8, 8);
        return g;
      })(),
      assert: (board, move) => {
        if (move.action !== 'reinforce' || !isSingleWinMove(move)) {
          return { ok: false, details: 'Expected a single-stone winning reinforce move.' };
        }
        // Accept any immediate winning single-stone placement.
        const undo = makeMove(board, move, BLACK);
        const winner = getWinnerAfterMove(board, move, BLACK);
        unmakeMove(board, undo, BLACK);
        if (winner !== BLACK) {
          return { ok: false, details: `Expected an immediate win, got ${winner ?? 'no winner'}.` };
        }
        return { ok: true };
      },
    },
    {
      name: 'Must-block: opponent open four is neutralized',
      toMove: BLACK,
      board: (() => {
        const g = emptyGrid();
        // White has _WWWW_ horizontally at row 7, cols 5-8.
        place(g, 'white', 7, 5);
        place(g, 'white', 7, 6);
        place(g, 'white', 7, 7);
        place(g, 'white', 7, 8);
        // Some black stones elsewhere.
        place(g, 'black', 6, 6);
        place(g, 'black', 8, 8);
        return g;
      })(),
      assert: (board, move) => {
        const after = applyMove(board, move, BLACK);
        const wins = findWinningPositions(after, WHITE);
        if (wins.length !== 0) {
          return { ok: false, details: `Opponent still has winning squares: ${wins.map(i => `${i}`).join(',')}` };
        }
        return { ok: true };
      },
    },
    {
      name: 'Must-block: opponent gap four is neutralized',
      toMove: BLACK,
      board: (() => {
        const g = emptyGrid();
        // White has WW_WW horizontally at row 7, gap at col 7.
        place(g, 'white', 7, 5);
        place(g, 'white', 7, 6);
        place(g, 'white', 7, 8);
        place(g, 'white', 7, 9);
        // Some black stones elsewhere.
        place(g, 'black', 6, 6);
        place(g, 'black', 8, 8);
        return g;
      })(),
      assert: (board, move) => {
        const after = applyMove(board, move, BLACK);
        const wins = findWinningPositions(after, WHITE);
        if (wins.length !== 0) {
          return { ok: false, details: `Opponent still has winning squares: ${wins.map(i => `${i}`).join(',')}` };
        }
        return { ok: true };
      },
    },
    {
      name: 'Rift-only defense: Ko blocks the only winning square',
      toMove: BLACK,
      ko: { row: 7, col: 4 },
      board: (() => {
        const g = emptyGrid();
        // White has WWWW_ at the left edge; winning square is (7,4), but it is Ko-blocked.
        place(g, 'white', 7, 0);
        place(g, 'white', 7, 1);
        place(g, 'white', 7, 2);
        place(g, 'white', 7, 3);
        // A couple black stones elsewhere.
        place(g, 'black', 6, 6);
        place(g, 'black', 8, 8);
        return g;
      })(),
      assert: (board, move) => {
        if (move.action !== 'rift') {
          return { ok: false, details: 'Expected rift as the only practical defense (Ko blocks placement).' };
        }
        const after = applyMove(board, move, BLACK);
        if (hasImmediateWinningMove(after, WHITE)) {
          return { ok: false, details: 'Opponent still has an immediate winning move after rift.' };
        }
        return { ok: true };
      },
    },
    {
      name: 'TSS regression: Ko-blocked half-four is defended by rift (Ko treated as open for threat detection)',
      toMove: WHITE,
      ko: { row: 7, col: 4 },
      board: (() => {
        const g = emptyGrid();
        // Black has a HALF_FOUR along the left edge (row 7, cols 0-3). The only winning square is (7,4),
        // but it is currently Ko-blocked for White, so White must defend by rifting one of the black stones.
        place(g, 'black', 7, 0);
        place(g, 'black', 7, 1);
        place(g, 'black', 7, 2);
        place(g, 'black', 7, 3);
        // A couple white stones elsewhere.
        place(g, 'white', 6, 6);
        place(g, 'white', 8, 8);
        return g;
      })(),
      assert: (board, move) => {
        // 1) Engine move should be a rift defense (cannot block Ko square by placement).
        if (move.action !== 'rift') {
          return { ok: false, details: 'Expected rift defense against Ko-blocked HALF_FOUR.' };
        }
        const after = applyMove(board, move, WHITE);
        if (hasImmediateWinningMove(after, BLACK)) {
          return { ok: false, details: 'Black still has an immediate winning move after the defense.' };
        }

        // 2) TSS should also find a rift refutation (regression: requires Ko-aware threat detection).
        const tss = threatSpaceSearch(board, BLACK, WHITE, {
          timeLimitMs: 200,
          maxPlies: 6,
          maxAttackerMoves: 16,
          maxDefenderMoves: 32,
        });
        if (tss.status !== 'not_proven' || !tss.move || tss.move.action !== 'rift') {
          return { ok: false, details: `Expected TSS defender refutation rift, got status=${tss.status} move=${tss.move?.action ?? 'null'}` };
        }
        const afterTss = applyMove(board, tss.move, WHITE);
        if (hasImmediateWinningMove(afterTss, BLACK)) {
          return { ok: false, details: 'TSS refutation does not actually prevent an immediate black win.' };
        }

        return { ok: true };
      },
    },
    {
      name: 'Fork defense: block two separate one-move wins in a single reinforce',
      toMove: BLACK,
      board: (() => {
        const g = emptyGrid();
        // Threat A: White has WWWW_ at left edge (row 5), winning square (5,4).
        place(g, 'white', 5, 0);
        place(g, 'white', 5, 1);
        place(g, 'white', 5, 2);
        place(g, 'white', 5, 3);

        // Threat B: White has _WWWW at right edge (row 9), winning square (9,10).
        place(g, 'white', 9, 11);
        place(g, 'white', 9, 12);
        place(g, 'white', 9, 13);
        place(g, 'white', 9, 14);

        // A couple black stones elsewhere.
        place(g, 'black', 7, 7);
        place(g, 'black', 6, 8);
        return g;
      })(),
      assert: (board, move) => {
        if (move.action !== 'reinforce') {
          return { ok: false, details: 'Expected reinforce to block both winning squares.' };
        }
        const a = toIndex(5, 4);
        const b = toIndex(9, 10);
        const hasA = move.pos1 === a || (!isSingleWinMove(move) && move.pos2 === a);
        const hasB = move.pos1 === b || (!isSingleWinMove(move) && move.pos2 === b);
        if (!hasA || !hasB) {
          return { ok: false, details: 'Expected blocks at (5,4) and (9,10).' };
        }
        const after = applyMove(board, move, BLACK);
        if (hasImmediateWinningMove(after, WHITE)) {
          return { ok: false, details: 'Opponent still has an immediate winning move after the blocks.' };
        }
        return { ok: true };
      },
    },
    {
      name: 'Two-stone threat: open three cannot be allowed to win by reinforce',
      toMove: BLACK,
      board: (() => {
        const g = emptyGrid();
        // White has WWW with both ends open; white can win next move by placing both ends.
        place(g, 'white', 7, 5);
        place(g, 'white', 7, 6);
        place(g, 'white', 7, 7);
        // Some black stones elsewhere.
        place(g, 'black', 6, 6);
        place(g, 'black', 8, 8);
        return g;
      })(),
      assert: (board, move) => {
        const after = applyMove(board, move, BLACK);
        if (hasImmediateWinningMove(after, WHITE)) {
          return { ok: false, details: 'Opponent still has an immediate winning move (two-stone reinforce win).' };
        }
        return { ok: true };
      },
    },
    {
      name: 'Ko-clears threat: rift is required when an open-four end is Ko-blocked',
      toMove: BLACK,
      ko: { row: 7, col: 4 },
      board: (() => {
        const g = emptyGrid();
        // White has _WWWW_ horizontally at row 7, cols 5-8.
        // Winning squares are (7,4) and (7,9). (7,4) is Ko-blocked right now,
        // but Ko will clear after black reinforce, so black must still address it.
        place(g, 'white', 7, 5);
        place(g, 'white', 7, 6);
        place(g, 'white', 7, 7);
        place(g, 'white', 7, 8);
        // Some black stones elsewhere.
        place(g, 'black', 6, 6);
        place(g, 'black', 8, 8);
        return g;
      })(),
      assert: (board, move) => {
        if (move.action !== 'rift') {
          return { ok: false, details: 'Expected rift; Ko prevents placing on the critical end this turn.' };
        }
        const after = applyMove(board, move, BLACK);
        if (hasImmediateWinningMove(after, WHITE)) {
          return { ok: false, details: 'Opponent still has an immediate winning move after rift.' };
        }
        return { ok: true };
      },
    },
    {
      name: 'Shield exception: double-block at both ends is a legal reinforce move',
      toMove: BLACK,
      board: (() => {
        const g = emptyGrid();
        // White has _WWWW_ horizontally at row 7, cols 5-8.
        // Black placing at (7,4) and (7,9) is colinear but SHOULD be legal because
        // there are opponent stones between them (shield exception).
        place(g, 'white', 7, 5);
        place(g, 'white', 7, 6);
        place(g, 'white', 7, 7);
        place(g, 'white', 7, 8);
        place(g, 'black', 6, 6);
        place(g, 'black', 8, 8);
        return g;
      })(),
      assert: (board) => {
        const a = toIndex(7, 4);
        const b = toIndex(7, 9);
        if (!validateReinforce(board, a, b, BLACK)) {
          return { ok: false, details: 'Expected shield-exception colinear reinforce to be legal.' };
        }
        return { ok: true };
      },
    },
    {
      name: 'Colinearity rule: adjacent colinear placements without shield are illegal',
      toMove: BLACK,
      board: (() => {
        const g = emptyGrid();
        // Empty board (center heuristics irrelevant). Adjacent horizontal placement
        // has no opponent stone between => should be illegal.
        return g;
      })(),
      assert: (board) => {
        const a = toIndex(7, 7);
        const b = toIndex(7, 8);
        if (validateReinforce(board, a, b, BLACK)) {
          return { ok: false, details: 'Expected adjacent colinear reinforce to be illegal without shield.' };
        }
        return { ok: true };
      },
    },
    {
      name: 'Overline trap: avoid rift that gives opponent exact-5 immediately',
      toMove: BLACK,
      board: (() => {
        const g = emptyGrid();
        // White has 6 in a row (overline is NOT a win). Any rift on this line would
        // trim it to an exact-5 segment, instantly giving White the win.
        place(g, 'white', 7, 0);
        place(g, 'white', 7, 1);
        place(g, 'white', 7, 2);
        place(g, 'white', 7, 3);
        place(g, 'white', 7, 4);
        place(g, 'white', 7, 5);
        // Some black stones elsewhere.
        place(g, 'black', 6, 6);
        place(g, 'black', 8, 8);
        return g;
      })(),
      assert: (board, move) => {
        if (move.action === 'rift') {
          return { ok: false, details: 'Rifting an overline should be avoided (gives opponent exact-5 win).' };
        }
        const undo = makeMove(board, move, BLACK);
        const winner = getWinnerAfterMove(board, move, BLACK);
        unmakeMove(board, undo, BLACK);
        if (winner === WHITE) {
          return { ok: false, details: 'Move should not immediately lose to exact-5 after rift/reinforce.' };
        }
        return { ok: true };
      },
    },
    {
      name: 'Edge-truncated diagonal: do not treat 4-length diagonals as threats (uncompletable exact-5)',
      toMove: BLACK,
      board: (() => {
        const g = emptyGrid();
        // Black has a diagonal "three" along a corner-truncated diagonal of length 4:
        // (0,11)-(1,12)-(2,13)-[3,14]. It can never become an exact-5 line.
        place(g, 'black', 0, 11);
        place(g, 'black', 1, 12);
        place(g, 'black', 2, 13);
        return g;
      })(),
      assert: (board) => {
        const p = countPatterns(board, BLACK);
        const total =
          p.FIVE +
          p.OPEN_FOUR +
          p.HALF_FOUR +
          p.GAP_FOUR +
          p.OPEN_THREE +
          p.HALF_THREE +
          p.GAP_THREE +
          p.OPEN_TWO +
          p.HALF_TWO;
        if (total !== 0) {
          return {
            ok: false,
            details: `Expected zero patterns (line cannot ever score exact-5), got: ${JSON.stringify(p)}`,
          };
        }
        return { ok: true };
      },
    },
    {
      name: 'Regression (GRR1): must-block immediate white win at (5,6)',
      toMove: BLACK,
      board: (() => {
        const g = emptyGrid();
        // GRR1 replay (black=ai, white=human). Reconstruct position after move 16 (white),
        // right before black move 17. Black must not allow white to win next move with wR5,6.
        //
        // Moves 1..16:
        applyLegacyReinforce(g, 'black', [6, 7], [8, 6]);   // 1 bR6,7;8,6
        applyLegacyReinforce(g, 'white', [7, 6], [8, 8]);   // 2 wR7,6;8,8
        applyLegacyReinforce(g, 'black', [7, 7], [7, 5]);   // 3 bR7,7;7,5
        applyLegacyReinforce(g, 'white', [8, 7], [8, 5]);   // 4 wR8,7;8,5
        applyLegacyReinforce(g, 'black', [6, 8], [4, 7]);   // 5 bR6,8;4,7
        applyLegacyReinforce(g, 'white', [8, 10], [5, 7]);  // 6 wR8,10;5,7
        applyLegacyReinforce(g, 'black', [5, 9], [6, 6]);   // 7 bR5,9;6,6
        applyLegacyReinforce(g, 'white', [4, 10], [9, 5]);  // 8 wR4,10;9,5
        applyLegacyReinforce(g, 'black', [6, 9], [9, 7]);   // 9 bR6,9;9,7
        applyLegacyReinforce(g, 'white', [6, 10], [6, 5]);  // 10 wR6,10;6,5
        applyLegacyReinforce(g, 'black', [6, 4], [9, 8]);   // 11 bR6,4;9,8
        applyLegacyReinforce(g, 'white', [5, 3], [10, 8]);  // 12 wR5,3;10,8
        applyLegacyReinforce(g, 'black', [9, 3], [9, 9]);   // 13 bR9,3;9,9
        applyLegacyReinforce(g, 'white', [7, 10], [5, 4]);  // 14 wR7,10;5,4
        applyLegacyReinforce(g, 'black', [4, 3], [5, 10]);  // 15 bR4,3;5,10
        applyLegacyReinforce(g, 'white', [8, 11], [5, 5]);  // 16 wR8,11;5,5
        return g;
      })(),
      assert: (board, move) => {
        const beforeWins = findWinningPositions(board, WHITE);
        const after = applyMove(board, move, BLACK);
        const afterWins = findWinningPositions(after, WHITE);

        // In this GRR1 position, White has a fork of immediate single-stone wins (multiple winning squares).
        // Black can only place two stones, and due to the colinearity constraint it may be impossible to
        // eliminate all winning squares in one move. So we assert the AI chooses a move that minimizes
        // the number of immediate winning squares available to White on the next turn.
        let bestPossible = Infinity;
        for (const { move: candidate } of generateAllMoves(board, BLACK)) {
          const candAfter = applyMove(board, candidate, BLACK);
          const candWins = findWinningPositions(candAfter, WHITE);
          if (candWins.length < bestPossible) bestPossible = candWins.length;
        }

        if (afterWins.length !== bestPossible) {
          return {
            ok: false,
            details: `Not best defense. beforeWins=${beforeWins.join(',')} afterWins=${afterWins.join(',')} bestPossible=${bestPossible}`,
          };
        }

        return { ok: true };
      },
    },
    {
      name: 'Regression (GRR1 corner filler): avoid wasting (0,0) as a defensive second stone',
      toMove: BLACK,
      board: (() => {
        const g = emptyGrid();
        // GRR1 replay (black=ai, white=human). Reconstruct position after move 12 (white),
        // right before black move 13 where the AI previously played a forced block + (0,0) filler.
        //
        // Moves 1..12:
        applyLegacyReinforce(g, 'black', [7, 8], [8, 6]);   // 1 bR7,8;8,6
        applyLegacyReinforce(g, 'white', [7, 6], [8, 8]);   // 2 wR7,6;8,8
        applyLegacyReinforce(g, 'black', [5, 8], [9, 8]);   // 3 bR5,8;9,8
        applyLegacyReinforce(g, 'white', [6, 7], [7, 9]);   // 4 wR6,7;7,9
        applyLegacyReinforce(g, 'black', [8, 7], [8, 9]);   // 5 bR8,7;8,9
        applyLegacyReinforce(g, 'white', [6, 8], [9, 7]);   // 6 wR6,8;9,7
        applyLegacyReinforce(g, 'black', [6, 10], [10, 6]); // 7 bR6,10;10,6
        applyLegacyReinforce(g, 'white', [5, 7], [6, 5]);   // 8 wR5,7;6,5
        applyLegacyReinforce(g, 'black', [8, 10], [4, 6]);  // 9 bR8,10;4,6
        applyLegacyReinforce(g, 'white', [6, 6], [8, 5]);   // 10 wR6,6;8,5
        applyLegacyReinforce(g, 'black', [6, 4], [6, 9]);   // 11 bR6,4;6,9
        applyLegacyReinforce(g, 'white', [7, 5], [9, 4]);   // 12 wR7,5;9,4
        return g;
      })(),
      assert: (board, move) => {
        // This regression targets a specific pathological behavior:
        // when a single forced block exists, the second stone was previously chosen by a raw
        // index sweep, leading to (0,0) corner garbage. We allow any correct defense, but
        // specifically forbid placing at (0,0) as the second stone.
        if (move.action === 'reinforce') {
          const corner = toIndex(0, 0);
          const playedCorner = move.pos1 === corner || (!isSingleWinMove(move) && move.pos2 === corner);
          if (playedCorner) {
            return { ok: false, details: 'Regression: played (0,0) as a defensive filler stone.' };
          }
        }

        const after = applyMove(board, move, BLACK);
        if (hasImmediateWinningMove(after, WHITE)) {
          return { ok: false, details: 'Defense still allows an immediate white win.' };
        }
        return { ok: true };
      },
    },
  ];

  const results: PuzzleResult[] = [];
  let passed = 0;
  let failed = 0;

  for (const p of puzzles) {
    const koIndex = p.ko ? p.ko.row * 15 + p.ko.col : null;
    const board = boardFrom2D(p.board, koIndex);
    const res = findBestMove(board, p.toMove, timeLimitMs, 8);
    const move = res.move;

    if (!move) {
      results.push({ name: p.name, ok: false, details: 'AI returned null move.' });
      failed++;
      continue;
    }

    const verdict = p.assert(board, move);
    if (verdict.ok) {
      results.push({ name: p.name, ok: true });
      passed++;
    } else {
      results.push({ name: p.name, ok: false, details: verdict.details });
      failed++;
    }
  }

  return { passed, failed, results };
}


