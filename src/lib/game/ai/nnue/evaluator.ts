/**
 * Incremental NNUE evaluator.
 *
 * Implements a simple 1-hidden-layer accumulator:
 *   hidden = bias + Σ featureWeights[activeFeature]
 *   value = tanh((dot(relu(hidden), outW) + outBias + phaseW*phase + stmW*stm) / outScale)
 *
 * The hidden accumulator supports O(hiddenDim) updates per stone add/remove.
 */

import { BOARD_CELLS } from '../constants';
import type { Board, CellIndex, Color, Move, UndoInfo } from '../types';
import { BLACK, WHITE, EMPTY } from '../types';
import { featureIndex } from './features';
import type { NnueWeights } from './weights';

export class NnueState {
  private readonly weights: NnueWeights;
  private readonly acc: Int32Array;

  private constructor(weights: NnueWeights) {
    this.weights = weights;
    this.acc = new Int32Array(weights.hiddenDim);
    for (let i = 0; i < weights.hiddenDim; i++) {
      this.acc[i] = weights.hiddenBias[i] ?? 0;
    }
  }

  static fromBoard(board: Board, weights: NnueWeights): NnueState {
    const st = new NnueState(weights);

    for (let i = 0; i < BOARD_CELLS; i++) {
      const v = board.cells[i];
      if (v === BLACK || v === WHITE) {
        st.addFeature(featureIndex(i, v));
      }
    }

    return st;
  }

  /**
   * Apply a move that has already been applied to the board.
   */
  applyMove(move: Move, mover: Color, undo: UndoInfo): void {
    if (move.action === 'reinforce') {
      this.addFeature(featureIndex(move.pos1, mover));
      if (move.pos2 !== null) {
        this.addFeature(featureIndex(move.pos2, mover));
      }
      return;
    }

    // Rift: board has removed opponent stone at move.pos.
    const captured = undo.capturedStone;
    if (captured === BLACK || captured === WHITE) {
      this.removeFeature(featureIndex(move.pos, captured));
    }
  }

  /**
   * Unapply (revert) a move, restoring accumulator to the pre-move state.
   */
  unapplyMove(move: Move, mover: Color, undo: UndoInfo): void {
    if (move.action === 'reinforce') {
      this.removeFeature(featureIndex(move.pos1, mover));
      if (move.pos2 !== null) {
        this.removeFeature(featureIndex(move.pos2, mover));
      }
      return;
    }

    // Rift: restore the captured stone feature.
    const captured = undo.capturedStone;
    if (captured === BLACK || captured === WHITE) {
      this.addFeature(featureIndex(move.pos, captured));
    }
  }

  /**
   * Evaluate from the perspective of `toMove`.
   * Returns a value in [-1, 1].
   */
  evaluateValue(board: Board, toMove: Color): number {
    const { outputWeights, outputBias, phaseWeight, stmWeight, outputScale } = this.weights;

    const stm = toMove === BLACK ? 1 : -1;
    const phase = (board.blackCount + board.whiteCount) / BOARD_CELLS;

    let sum = outputBias + phaseWeight * phase + stmWeight * stm;

    // dot(relu(hidden), outW)
    for (let i = 0; i < this.acc.length; i++) {
      const x = this.acc[i];
      if (x <= 0) continue;
      sum += x * outputWeights[i];
    }

    const vBlack = Math.tanh(sum / outputScale);
    // Convert black-advantage to player-perspective.
    return toMove === BLACK ? vBlack : -vBlack;
  }

  private addFeature(f: number): void {
    const H = this.weights.hiddenDim;
    const w = this.weights.inputWeights;
    let off = f * H;
    for (let i = 0; i < H; i++) {
      this.acc[i] += w[off + i];
    }
  }

  private removeFeature(f: number): void {
    const H = this.weights.hiddenDim;
    const w = this.weights.inputWeights;
    let off = f * H;
    for (let i = 0; i < H; i++) {
      this.acc[i] -= w[off + i];
    }
  }
}

