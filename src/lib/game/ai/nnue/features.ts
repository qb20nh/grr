/**
 * NNUE feature helpers for Gomoku Rift.
 *
 * We keep spatially-aware absolute planes:
 * - plane 0: black stones
 * - plane 1: white stones
 *
 * This preserves arrangement (lines/patterns) and keeps incremental updates cheap.
 */

import { BOARD_CELLS } from '../constants';
import type { CellIndex, Color } from '../types';
import { BLACK } from '../types';

export const NNUE_FEATURES_PER_PLANE = BOARD_CELLS; // 225
export const NNUE_PLANE_COUNT = 2;
export const NNUE_FEATURE_COUNT = NNUE_FEATURES_PER_PLANE * NNUE_PLANE_COUNT; // 450

/**
 * Map a stone (cell index + color) to a feature index in [0, NNUE_FEATURE_COUNT).
 */
export function featureIndex(cell: CellIndex, color: Color): number {
  // plane 0: black, plane 1: white
  return color === BLACK ? cell : NNUE_FEATURES_PER_PLANE + cell;
}

