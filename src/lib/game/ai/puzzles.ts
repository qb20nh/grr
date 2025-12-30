/**
 * Tactical puzzle/regression harness for the AI engine.
 *
 * This is intentionally lightweight (no test framework). It can be invoked
 * from the AI worker in debug mode to sanity-check must-block / forced-win behavior.
 */

import type { Board as InternalBoard, Color, Move } from './types';
import { BLACK, WHITE } from './types';
import { boardFrom2D, cloneBoard, makeMove, unmakeMove, getWinnerAfterMove } from './board';
import { findBestMove } from './search';
import { findWinningPositions } from './threats';
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
        const expected = toIndex(7, 7);
        if (move.pos1 !== expected) {
          return { ok: false, details: `Expected win at ${JSON.stringify(toPosition(expected))}.` };
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


