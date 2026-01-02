import type { Position } from './types';
import { BOARD_SIZE } from './types';

export function flattenUniquePositions(scoredLines: Position[][]): Position[] {
  const seen = new Set<number>();
  const out: Position[] = [];

  for (const line of scoredLines) {
    for (const pos of line) {
      if (pos.row < 0 || pos.row >= BOARD_SIZE || pos.col < 0 || pos.col >= BOARD_SIZE) continue;
      const idx = pos.row * BOARD_SIZE + pos.col;
      if (seen.has(idx)) continue;
      seen.add(idx);
      out.push(pos);
    }
  }

  return out;
}

