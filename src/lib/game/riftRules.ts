import type { GameState, OpeningPreset } from './types';

export const LONG_PRO_RIFT_FORBIDDEN_FIRST_TURNS = 3;

export function isRiftAllowedAtMoveIndex(openingPreset: OpeningPreset, moveIndex: number): boolean {
  if (openingPreset !== 'long-pro') return true;
  return moveIndex >= LONG_PRO_RIFT_FORBIDDEN_FIRST_TURNS;
}

export function isRiftAllowedForState(state: Pick<GameState, 'openingPreset' | 'moveHistory'>): boolean {
  return isRiftAllowedAtMoveIndex(state.openingPreset, state.moveHistory.length);
}

