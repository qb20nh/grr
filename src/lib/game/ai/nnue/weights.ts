/**
 * NNUE weights: binary format + loader.
 *
 * Design goals:
 * - Compact (quantized int8 weights)
 * - Fast incremental evaluation (feature -> hidden vectors)
 * - Safe optional loading (return null on missing/corrupt weights)
 */

import { NNUE_FEATURE_COUNT, NNUE_FEATURES_PER_PLANE } from './features';

export interface NnueWeights {
  readonly version: number;
  readonly boardSize: number;
  readonly featureCount: number;
  readonly hiddenDim: number;
  readonly outputScale: number;
  readonly phaseWeight: number;
  readonly stmWeight: number;
  readonly outputBias: number;
  readonly hiddenBias: Int16Array;
  readonly inputWeights: Int8Array; // [featureCount * hiddenDim]
  readonly outputWeights: Int8Array; // [hiddenDim]
}

const MAGIC = 'GRRNNUE1'; // 8 bytes
const VERSION = 1;

function readMagic(dv: DataView, offset: number): string {
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += String.fromCharCode(dv.getUint8(offset + i));
  }
  return out;
}

export function decodeNnueWeights(buffer: ArrayBuffer): NnueWeights {
  const dv = new DataView(buffer);
  if (dv.byteLength < 36) {
    throw new Error('NNUE weights: file too small');
  }

  const magic = readMagic(dv, 0);
  if (magic !== MAGIC) {
    throw new Error(`NNUE weights: bad magic "${magic}"`);
  }

  const version = dv.getUint32(8, true);
  if (version !== VERSION) {
    throw new Error(`NNUE weights: unsupported version ${version}`);
  }

  const boardSize = dv.getUint16(12, true);
  const featureCount = dv.getUint16(14, true);
  const hiddenDim = dv.getUint16(16, true);
  // reserved u16 at 18

  const outputScale = dv.getFloat32(20, true);
  const phaseWeight = dv.getFloat32(24, true);
  const stmWeight = dv.getFloat32(28, true);
  const outputBias = dv.getFloat32(32, true);

  if (!Number.isFinite(outputScale) || outputScale <= 0) {
    throw new Error('NNUE weights: invalid outputScale');
  }
  if (!Number.isFinite(phaseWeight) || !Number.isFinite(stmWeight) || !Number.isFinite(outputBias)) {
    throw new Error('NNUE weights: invalid scalar weights');
  }

  // Basic shape sanity checks.
  if (boardSize <= 0 || boardSize > 255) {
    throw new Error('NNUE weights: invalid boardSize');
  }
  if (featureCount !== NNUE_FEATURE_COUNT) {
    // This keeps runtime + training in sync (for now we only support 15x15*2 planes).
    throw new Error(`NNUE weights: unexpected featureCount=${featureCount} (expected ${NNUE_FEATURE_COUNT})`);
  }
  if (hiddenDim <= 0 || hiddenDim > 512) {
    throw new Error('NNUE weights: unreasonable hiddenDim');
  }

  // Layout after header (36 bytes):
  // - hiddenBias: int16[hiddenDim]
  // - inputWeights: int8[featureCount * hiddenDim]
  // - outputWeights: int8[hiddenDim]
  let offset = 36;

  const hiddenBias = new Int16Array(hiddenDim);
  const hiddenBiasBytes = hiddenDim * 2;
  if (offset + hiddenBiasBytes > dv.byteLength) {
    throw new Error('NNUE weights: truncated hiddenBias');
  }
  for (let i = 0; i < hiddenDim; i++) {
    hiddenBias[i] = dv.getInt16(offset + i * 2, true);
  }
  offset += hiddenBiasBytes;

  const inputLen = featureCount * hiddenDim;
  if (offset + inputLen > dv.byteLength) {
    throw new Error('NNUE weights: truncated inputWeights');
  }
  const inputWeights = new Int8Array(buffer, offset, inputLen);
  offset += inputLen;

  if (offset + hiddenDim > dv.byteLength) {
    throw new Error('NNUE weights: truncated outputWeights');
  }
  const outputWeights = new Int8Array(buffer, offset, hiddenDim);
  offset += hiddenDim;

  // Allow extra bytes for forward-compatible extensions.

  // Derive boardSize from feature shape as an extra sanity check when possible.
  // featureCount = 2 * boardCells => boardCells = featureCount/2.
  const boardCells = featureCount / 2;
  const inferredSize = Math.round(Math.sqrt(boardCells));
  if (inferredSize * inferredSize === boardCells && inferredSize !== boardSize) {
    // Not fatal, but strongly suspicious.
    throw new Error(`NNUE weights: boardSize mismatch (header=${boardSize}, inferred=${inferredSize})`);
  }

  // Extra check for 15x15 (current engine board).
  if (featureCount / 2 !== NNUE_FEATURES_PER_PLANE) {
    throw new Error('NNUE weights: features-per-plane mismatch');
  }

  return {
    version,
    boardSize,
    featureCount,
    hiddenDim,
    outputScale,
    phaseWeight,
    stmWeight,
    outputBias,
    hiddenBias,
    inputWeights,
    outputWeights,
  };
}

/**
 * Return the default URL where the app expects bundled weights if present.
 *
 * This path is served by SvelteKit/Vite when you put the file at:
 * `static/nnue/weights.bin`
 */
export function getBundledWeightsUrl(): URL {
  const loc = (globalThis as unknown as { location?: Location }).location;
  const origin = loc?.origin ?? 'http://localhost';
  // In this repo, production builds may be served under a non-root base path (e.g. `/grr`).
  // Vite exposes that via `import.meta.env.BASE_URL`.
  const baseRaw = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  const base = baseRaw.endsWith('/') ? baseRaw : `${baseRaw}/`;
  return new URL(`${base}nnue/weights.bin`, origin);
}

/**
 * Load NNUE weights if available.
 *
 * - Returns null on 404 / missing weights.
 * - Returns null on any fetch/parse error (caller can optionally log once).
 */
export async function loadNnueWeightsOptional(url: URL = getBundledWeightsUrl()): Promise<NnueWeights | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    return decodeNnueWeights(buf);
  } catch {
    return null;
  }
}

