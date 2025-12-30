/**
 * Compact Move encoding/decoding for typed-array storage (TT, caches).
 *
 * Encoding fits into a signed 32-bit integer.
 *
 * Layout:
 * - bits 0..7:  pos1 (0..224)
 * - bits 8..15: pos2 (0..224) or 255 sentinel
 * - bits 16..17: kind
 *     0 = reinforce (two stones)
 *     1 = single-win reinforce (pos2 = 255 sentinel)
 *     2 = rift (pos1 = rift target)
 */

import type { Move } from './types';
import { createReinforceMove, createRiftMove, createSingleWinMove, isSingleWinMove } from './utils';

export const MOVE_CODE_NONE = -1;

export function encodeMove(move: Move | null): number {
  if (!move) return MOVE_CODE_NONE;

  if (move.action === 'rift') {
    return (2 << 16) | (move.pos & 0xff);
  }

  if (isSingleWinMove(move)) {
    return (1 << 16) | (move.pos1 & 0xff) | (0xff << 8);
  }

  const a = Math.min(move.pos1, move.pos2) & 0xff;
  const b = Math.max(move.pos1, move.pos2) & 0xff;
  return (0 << 16) | a | (b << 8);
}

export function decodeMove(code: number): Move | null {
  if (code === MOVE_CODE_NONE) return null;

  const kind = (code >>> 16) & 0x3;
  const pos1 = code & 0xff;
  const pos2 = (code >>> 8) & 0xff;

  if (kind === 2) {
    return createRiftMove(pos1);
  }

  if (kind === 1) {
    return createSingleWinMove(pos1);
  }

  return createReinforceMove(pos1, pos2);
}


