import type { GameState, Position } from './types';
import { CENTER_POS, positionsEqual } from './types';

// Long Pro (turn three / Black's second move): the forbidden center region is a diamond
// (Manhattan distance <= 2 from center).
export const LONG_PRO_FORBIDDEN_MANHATTAN_RADIUS = 2;
export const LONG_PRO_MIN_MANHATTAN_FROM_CENTER = LONG_PRO_FORBIDDEN_MANHATTAN_RADIUS + 1;

export type OpeningRelevantState = Pick<GameState, 'openingPreset' | 'currentPlayer' | 'moveHistory'>;

export function isOutsideLongProCenterRegion(
  pos: Position,
  center: Position = CENTER_POS
): boolean {
  const dr = Math.abs(pos.row - center.row);
  const dc = Math.abs(pos.col - center.col);
  return dr + dc >= LONG_PRO_MIN_MANHATTAN_FROM_CENTER;
}

export function isLongProForcedCenterMove(state: OpeningRelevantState): boolean {
  return (
    state.openingPreset === 'long-pro' &&
    state.currentPlayer === 'black' &&
    state.moveHistory.length === 0
  );
}

export function isLongProRestrictedBlackSecondMove(state: OpeningRelevantState): boolean {
  return (
    state.openingPreset === 'long-pro' &&
    state.currentPlayer === 'black' &&
    state.moveHistory.length === 2
  );
}

export function isLongProRestrictedBlackSecondReinforce(state: OpeningRelevantState): boolean {
  return isLongProRestrictedBlackSecondMove(state);
}

export function validateReinforceOpeningConstraint(
  state: OpeningRelevantState,
  positions: Position[]
): { ok: boolean; reason?: string } {
  if (state.openingPreset !== 'long-pro') return { ok: true };

  if (isLongProForcedCenterMove(state)) {
    if (positions.length !== 1) {
      return { ok: false, reason: 'Long Pro: Black must place exactly 1 stone on the first move.' };
    }
    if (!positionsEqual(positions[0] ?? null, CENTER_POS)) {
      return { ok: false, reason: 'Long Pro: Black’s first stone must be placed at the center.' };
    }
    return { ok: true };
  }

  if (isLongProRestrictedBlackSecondReinforce(state)) {
    if (positions.length !== 2) {
      return { ok: false, reason: 'Long Pro: Black must place 2 stones on this move.' };
    }
    for (const pos of positions) {
      if (!isOutsideLongProCenterRegion(pos, CENTER_POS)) {
        return {
          ok: false,
          reason: 'Long Pro: Black stones must be outside the center diamond (distance 2).',
        };
      }
    }
    return { ok: true };
  }

  return { ok: true };
}

