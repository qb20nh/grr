import { BOARD_SIZE } from './constants';

export type DihedralRot = 0 | 1 | 2 | 3;

export interface Dihedral {
  /** Rotation in 90° steps clockwise. */
  rot: DihedralRot;
  /** Mirror across the vertical axis after rotation. */
  reflect: boolean;
}

export interface RcPos {
  row: number;
  col: number;
}

export function randomDihedral(rng: () => number = Math.random): Dihedral {
  const rot = Math.floor(rng() * 4) as DihedralRot;
  const reflect = rng() < 0.5;
  return { rot, reflect };
}

function rotatePos(pos: RcPos, rot: DihedralRot, size: number): RcPos {
  const r = pos.row;
  const c = pos.col;
  const n = size - 1;
  switch (rot) {
    case 0: return { row: r, col: c };
    case 1: return { row: c, col: n - r };
    case 2: return { row: n - r, col: n - c };
    case 3: return { row: n - c, col: r };
  }
}

function reflectPos(pos: RcPos, size: number): RcPos {
  return { row: pos.row, col: (size - 1) - pos.col };
}

export function applyDihedralPos(pos: RcPos, d: Dihedral, size: number = BOARD_SIZE): RcPos {
  const rotated = rotatePos(pos, d.rot, size);
  return d.reflect ? reflectPos(rotated, size) : rotated;
}

export function applyInverseDihedralPos(pos: RcPos, d: Dihedral, size: number = BOARD_SIZE): RcPos {
  // Forward is rotate then reflect (optional). Inverse is reflect then inverse-rotate.
  const unreflected = d.reflect ? reflectPos(pos, size) : pos;
  const invRot = ((4 - d.rot) & 3) as DihedralRot;
  return rotatePos(unreflected, invRot, size);
}

export function transformLegacyBoard(
  board: (string | null)[][],
  d: Dihedral,
  size: number = BOARD_SIZE
): (string | null)[][] {
  const out: (string | null)[][] = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => null)
  );

  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const dst = applyDihedralPos({ row, col }, d, size);
      out[dst.row][dst.col] = board[row]?.[col] ?? null;
    }
  }

  return out;
}

export function transformLegacyKo(
  lastRiftedPosition: RcPos | null,
  d: Dihedral,
  size: number = BOARD_SIZE
): RcPos | null {
  if (!lastRiftedPosition) return null;
  return applyDihedralPos(lastRiftedPosition, d, size);
}

