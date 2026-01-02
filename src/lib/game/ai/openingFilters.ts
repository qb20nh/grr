import { BOARD_SIZE } from './constants';
import type { Color, Move } from './types';
import { BLACK, WHITE } from './types';
import { isSingleWinMove } from './utils';
import type { OpeningPreset } from '../types';

export const LONG_PRO_MIN_CHEBYSHEV_FROM_CENTER = 4;

const CENTER_RC = Math.floor(BOARD_SIZE / 2);

function chebyshevFromCenter(index: number): number {
  const r = Math.floor(index / BOARD_SIZE);
  const c = index % BOARD_SIZE;
  return Math.max(Math.abs(r - CENTER_RC), Math.abs(c - CENTER_RC));
}

function longProBlackSecondMoveFilter(m: Move): boolean {
  // Long Pro: on Black’s second move (third ply overall), rift targets inside the forbidden
  // center region are not allowed.
  if (m.action === 'rift') {
    return chebyshevFromCenter(m.pos) >= LONG_PRO_MIN_CHEBYSHEV_FROM_CENTER;
  }
  if (m.action !== 'reinforce') return true;

  // Long Pro: Black must place exactly 2 stones on this move (no single-stone moves, even if winning).
  if (isSingleWinMove(m)) return false;

  // Both stones must be outside the blocked center region.
  return (
    chebyshevFromCenter(m.pos1) >= LONG_PRO_MIN_CHEBYSHEV_FROM_CENTER &&
    chebyshevFromCenter(m.pos2) >= LONG_PRO_MIN_CHEBYSHEV_FROM_CENTER
  );
}

/**
 * Root move filter for opening-dependent legality rules.
 */
export function getOpeningRootMoveFilter(
  openingPreset: OpeningPreset,
  moveIndex: number,
  player: Color
): ((m: Move) => boolean) | null {
  if (openingPreset !== 'long-pro') return null;
  if (player !== BLACK) return null;
  if (moveIndex !== 2) return null;
  return longProBlackSecondMoveFilter;
}

/**
 * Ply-1 reply filter used to let the side-to-move correctly anticipate opening
 * constraints on the opponent's *next* move.
 *
 * Currently only used for Long Pro: when White is choosing moveIndex=1, Black's
 * immediate reply (moveIndex=2) is restricted outside the center region.
 */
export function getOpeningPly1ReplyMoveFilter(
  openingPreset: OpeningPreset,
  moveIndex: number,
  player: Color
): ((m: Move) => boolean) | null {
  if (openingPreset !== 'long-pro') return null;
  if (player !== WHITE) return null;
  if (moveIndex !== 1) return null;
  // Black's next move (moveIndex=2) is restricted.
  return longProBlackSecondMoveFilter;
}

