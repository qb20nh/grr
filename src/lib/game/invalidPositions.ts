import type { GameState, Position } from './types';
import { BOARD_SIZE, CENTER_POS, getOpponent, positionsEqual } from './types';
import {
  isLongProForcedCenterMove,
  isLongProRestrictedBlackSecondMove,
  isOutsideLongProCenterRegion,
} from './openingRules';
import { checkColinearityConstraint } from './validator';

export type InvalidPositionsState = Pick<
  GameState,
  'board' | 'currentPlayer' | 'openingPreset' | 'moveHistory' | 'pendingPlacements' | 'lastRiftedPosition'
>;

/**
 * Compute "invalid" intersections for UI affordances (opening constraints, colinearity).
 *
 * This is intentionally pure and phase-agnostic so it can be reused in replay mode.
 */
export function computeInvalidPositions(state: InvalidPositionsState): Set<string> {
  const invalid = new Set<string>();

  // ---- Long Pro opening constraints ----
  if (isLongProForcedCenterMove(state)) {
    for (let row = 0; row < BOARD_SIZE; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        if (state.board[row][col] !== null) continue;
        const pos: Position = { row, col };
        if (!positionsEqual(pos, CENTER_POS)) {
          invalid.add(`${row},${col}`);
        }
      }
    }
  } else if (isLongProRestrictedBlackSecondMove(state)) {
    const opponent = getOpponent(state.currentPlayer);
    for (let row = 0; row < BOARD_SIZE; row++) {
      for (let col = 0; col < BOARD_SIZE; col++) {
        const pos: Position = { row, col };
        const cell = state.board[row][col];
        // Mark the forbidden center region for BOTH:
        // - empty intersections (illegal reinforce placements), and
        // - opponent stones (illegal rift targets) on Black's restricted 3rd turn.
        if (cell !== null && cell !== opponent) continue;
        if (!isOutsideLongProCenterRegion(pos, CENTER_POS)) {
          invalid.add(`${row},${col}`);
        }
      }
    }
  }

  // When we have one pending placement, mark colinearity-invalid positions
  if (state.pendingPlacements.length === 1) {
    const firstPos = state.pendingPlacements[0];
    if (firstPos) {
      for (let row = 0; row < BOARD_SIZE; row++) {
        for (let col = 0; col < BOARD_SIZE; col++) {
          const pos: Position = { row, col };
          if (
            state.board[row][col] === null &&
            !positionsEqual(pos, state.lastRiftedPosition) &&
            !positionsEqual(pos, firstPos)
          ) {
            if (!checkColinearityConstraint(state.board, firstPos, pos, state.currentPlayer)) {
              invalid.add(`${row},${col}`);
            }
          }
        }
      }
    }
  }

  return invalid;
}

