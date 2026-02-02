import type { Position, GameState, PlayerColor } from './types';
import { CENTER_POS, positionsEqual, getOpponent } from './types';
import { gameStore } from '$lib/stores/gameStore';
import { validateReinforceAction, validateRiftAction, isValidPlacement, checkColinearityConstraint, wouldScoreWithSingleStone, hasAnyLegalReinforceMove } from './validator';
import { getScoringLinesAfterRift, getScoringLinesForPlacements } from './winChecker';
import { LONG_PRO_RIFT_FORBIDDEN_FIRST_TURNS, isRiftAllowedForState } from './riftRules';
import {
  isLongProForcedCenterMove,
  isLongProRestrictedBlackSecondMove,
  isOutsideLongProCenterRegion,
  validateReinforceOpeningConstraint,
} from './openingRules';
import { computeInvalidPositions } from './invalidPositions';

// Fast mode reduces/disables animation delays for automated testing
let fastModeEnabled = false;

export function setFastMode(enabled: boolean): void {
  fastModeEnabled = enabled;
}

export function isFastMode(): boolean {
  return fastModeEnabled;
}

function getAnimationDelay(): number {
  return fastModeEnabled ? 0 : 500;
}

function getTurnDelay(): number {
  return fastModeEnabled ? 0 : 300;
}

export interface GameEngine {
  handleBoardClick(pos: Position): void;
  canPlaceAt(pos: Position): boolean;
  canRiftAt(pos: Position): boolean;
  confirmMove(): void;
  cancelMove(): void;
  executeAiTurn(): void;
  getInvalidPositions(): Set<string>;
  terminateAi(): void;
}

export function createGameEngine(): GameEngine {
  function getState(): GameState {
    return gameStore.getState();
  }

  function validateReinforceConsideringOpening(
    state: GameState,
    positions: Position[]
  ): { valid: boolean; reason?: string; allowNonScoringSingle?: boolean } {
    const opening = validateReinforceOpeningConstraint(state, positions);
    if (!opening.ok) return { valid: false, reason: opening.reason };

    // Special-case: Long Pro forced first move is a non-scoring single stone at center.
    if (isLongProForcedCenterMove(state)) {
      const pos = positions[0];
      if (!pos) return { valid: false, reason: 'Missing position' };
      if (!isValidPlacement(state.board, pos, state.lastRiftedPosition)) {
        return { valid: false, reason: 'Position is invalid' };
      }
      return { valid: true, allowNonScoringSingle: true };
    }

    const validation = validateReinforceAction(
      state.board,
      positions,
      state.currentPlayer,
      state.lastRiftedPosition
    );
    if (!validation.valid) return { valid: false, reason: validation.reason };
    return { valid: true };
  }

  function validateRiftConsideringOpening(
    state: GameState,
    pos: Position
  ): { valid: boolean; reason?: string } {
    if (!isRiftAllowedForState(state)) {
      return {
        valid: false,
        reason: `Long Pro: Rift is not allowed on turns 1-${LONG_PRO_RIFT_FORBIDDEN_FIRST_TURNS}.`,
      };
    }

    const base = validateRiftAction(state.board, pos, state.currentPlayer);
    if (!base.valid) return base;

    // Long Pro: on Black’s second move (third ply overall), rift targets inside the forbidden
    // center diamond region are not allowed.
    if (isLongProRestrictedBlackSecondMove(state) && !isOutsideLongProCenterRegion(pos, CENTER_POS)) {
      return {
        valid: false,
        reason: 'Long Pro: Black cannot rift inside the forbidden center diamond on this move.',
      };
    }

    return { valid: true };
  }

  function maybeEndUnlimitedOnExhaustion(): boolean {
    const state = getState();
    if (state.phase !== 'playing') return true;
    if (state.winner) return true;
    if (state.endReason !== null) return true;
    if (state.scoreToWin !== 0) return false;

    const hasReinforce = hasAnyLegalReinforceMove(
      state.board,
      state.currentPlayer,
      state.lastRiftedPosition
    );
    if (hasReinforce) {
      return false;
    }

    // If reinforce is exhausted, allow play to continue as long as a rift is available.
    // Unlimited mode ends only when the side to move has no legal move at all.
    const opponent = getOpponent(state.currentPlayer);
    for (let row = 0; row < 15; row++) {
      for (let col = 0; col < 15; col++) {
        if (state.board[row][col] === opponent) {
          return false;
        }
      }
    }

    const b = state.scores.black;
    const w = state.scores.white;
    const winner: PlayerColor | null = b === w ? null : b > w ? 'black' : 'white';
    gameStore.endGame(winner, 'exhaustion');
    return true;
  }

  function handleBoardClick(pos: Position): void {
    const state = getState();
    
    if (state.phase !== 'playing' || state.winner) {
      return;
    }

    // If AI is thinking, ignore clicks
    if (state.aiThinking) {
      return;
    }

    // Spectate mode: no human interaction
    if (state.gameMode === 'ai-vs-ai') {
      return;
    }

    // If it's AI's turn, ignore clicks
    if (state.gameMode === 'vs-ai' && state.currentPlayer === state.aiColor) {
      return;
    }

    const opponent = getOpponent(state.currentPlayer);
    const clickedStone = state.board[pos.row]?.[pos.col];

    // Action lock: don't auto-switch modes when action is pending
    // User must explicitly cancel before switching to another action type
    
    if (clickedStone === opponent) {
      // Clicked on opponent stone - would be Rift action
      // Block if there are pending placements (user is in reinforce mode)
      if (state.pendingPlacements.length > 0) {
        return; // Ignore - must cancel reinforce first
      }
      handleRiftSelection(pos);
    } else if (clickedStone === null) {
      // Clicked on empty spot - would be Reinforce action
      // Block if there's a pending rift (user is in rift mode)
      if (state.pendingRift !== null) {
        return; // Ignore - must cancel rift first
      }
      handleReinforcePlacement(pos);
    }
    // Clicking on own stone does nothing
  }

  function handleReinforcePlacement(pos: Position): void {
    const state = getState();
    
    // Note: No auto-clearing of pending rift here - handleBoardClick blocks
    // reinforce clicks when rift is pending (user must explicitly cancel)

    // Check if position is valid
    if (!isValidPlacement(state.board, pos, state.lastRiftedPosition)) {
      return;
    }

    // Long Pro: forced first move is center-only (single stone).
    if (isLongProForcedCenterMove(state) && !positionsEqual(pos, CENTER_POS)) {
      return;
    }

    // Long Pro: on Black’s second move (third ply overall), both reinforce stones must be outside the center region.
    if (isLongProRestrictedBlackSecondMove(state) && !isOutsideLongProCenterRegion(pos, CENTER_POS)) {
      return;
    }

    // Check if this position is already pending - toggle it off
    if (state.pendingPlacements.some(p => positionsEqual(p, pos))) {
      // Remove this position (deselect)
      const remaining = state.pendingPlacements.filter(p => !positionsEqual(p, pos));
      gameStore.clearPendingPlacements();
      remaining.forEach(p => gameStore.addPendingPlacement(p));
      return;
    }

    // If we already have 2 pending, clear and start fresh
    if (state.pendingPlacements.length >= 2) {
      gameStore.clearPendingPlacements();
      gameStore.addPendingPlacement(pos);
      return;
    }

    // If we have one pending, check colinearity with this new position
    if (state.pendingPlacements.length === 1) {
      const firstPos = state.pendingPlacements[0];
      if (!checkColinearityConstraint(state.board, firstPos, pos, state.currentPlayer)) {
        // Invalid due to colinearity - don't add
        return;
      }
    }

    // Add to pending
    gameStore.addPendingPlacement(pos);
  }

  function handleRiftSelection(pos: Position): void {
    const state = getState();
    
    const validation = validateRiftConsideringOpening(state, pos);
    if (!validation.valid) {
      return;
    }

    // Toggle: if same position is already pending, cancel it
    if (state.pendingRift && positionsEqual(state.pendingRift, pos)) {
      gameStore.setPendingRift(null);
      return;
    }

    // Set as pending rift target
    gameStore.setPendingRift(pos);
  }

  function confirmMove(): void {
    const state = getState();
    
    if (state.phase !== 'playing' || state.winner || state.aiThinking) {
      return;
    }

    if (state.gameMode === 'ai-vs-ai') {
      return;
    }

    if (state.pendingPlacements.length === 2) {
      executeReinforce(state.pendingPlacements);
    } else if (state.pendingPlacements.length === 1) {
      // Single stone - only allowed if it scores (except Long Pro forced center move).
      const pos = state.pendingPlacements[0];
      if (isLongProForcedCenterMove(state) && positionsEqual(pos, CENTER_POS)) {
        executeReinforce([pos]);
      } else if (wouldScoreWithSingleStone(state.board, pos, state.currentPlayer)) {
        executeReinforce(state.pendingPlacements);
      }
    } else if (state.pendingRift) {
      executeRift(state.pendingRift);
    }
  }

  function cancelMove(): void {
    const state = getState();
    if (state.gameMode === 'ai-vs-ai') return;
    gameStore.clearPendingPlacements();
  }

  function executeReinforce(positions: Position[]): void {
    const state = getState();
    const validation = validateReinforceConsideringOpening(state, positions);
    if (!validation.valid) return;

    const player = state.currentPlayer;

    // Create board-after to check scoring lines (exact-5).
    const boardAfter = state.board.map(row => [...row]);
    for (const pos of positions) {
      boardAfter[pos.row][pos.col] = player;
    }

    const scoredLines = getScoringLinesForPlacements(boardAfter, positions, player);
    gameStore.applyReinforceMove(positions, scoredLines);

    if (scoredLines.length > 0) {
      const after = getState();
      if (after.scoreToWin !== 0 && after.scores[player] >= after.scoreToWin) {
        gameStore.endGame(player, 'score');
        return;
      }
    }

    // Single-stone reinforce is only allowed when it scores.
    if (positions.length === 1 && scoredLines.length === 0) {
      if (!validation.allowNonScoringSingle) {
        console.warn('Single stone placement without score - this should not happen');
        return;
      }
    }

    gameStore.switchPlayer();
    
    // Trigger AI if needed
    const updatedState = getState();
    if (maybeEndUnlimitedOnExhaustion()) {
      return;
    }
    if (updatedState.gameMode === 'vs-ai' && updatedState.currentPlayer === updatedState.aiColor) {
      setTimeout(() => executeAiTurn(), getTurnDelay());
    } else if (updatedState.gameMode === 'ai-vs-ai') {
      setTimeout(() => executeAiTurn(), getTurnDelay());
    }
  }

  function executeRift(pos: Position): void {
    const state = getState();

    const validation = validateRiftConsideringOpening(state, pos);
    if (!validation.valid) {
      console.warn('Illegal rift move rejected', { pos, reason: validation.reason });
      // Defensive: clear any pending selection so the human can continue.
      gameStore.setPendingRift(null);
      return;
    }
    
    const removedColor = getOpponent(state.currentPlayer);

    const boardAfter = state.board.map(row => [...row]);
    boardAfter[pos.row][pos.col] = null;

    const scoredLines = getScoringLinesAfterRift(boardAfter, pos, removedColor);
    const scoredBy: PlayerColor | null = scoredLines.length > 0 ? removedColor : null;

    gameStore.applyRiftMove(pos, scoredBy, scoredLines);

    if (scoredBy) {
      const after = getState();
      if (after.scoreToWin !== 0 && after.scores[scoredBy] >= after.scoreToWin) {
        gameStore.endGame(scoredBy, 'score');
        return;
      }
    }

    gameStore.switchPlayer();
    
    // Trigger AI if needed
    const updatedState = getState();
    if (maybeEndUnlimitedOnExhaustion()) {
      return;
    }
    if (updatedState.gameMode === 'vs-ai' && updatedState.currentPlayer === updatedState.aiColor) {
      setTimeout(() => executeAiTurn(), getTurnDelay());
    } else if (updatedState.gameMode === 'ai-vs-ai') {
      setTimeout(() => executeAiTurn(), getTurnDelay());
    }
  }

  function canPlaceAt(pos: Position): boolean {
    const state = getState();
    
    if (state.phase !== 'playing' || state.winner || state.aiThinking) {
      return false;
    }

    if (state.gameMode === 'ai-vs-ai') {
      return false;
    }

    if (!isValidPlacement(state.board, pos, state.lastRiftedPosition)) {
      return false;
    }

    // Long Pro: forced first move is center-only (single stone).
    if (isLongProForcedCenterMove(state) && !positionsEqual(pos, CENTER_POS)) {
      return false;
    }

    // Long Pro: on Black’s second move, reinforce stones must be outside the center region.
    if (isLongProRestrictedBlackSecondMove(state) && !isOutsideLongProCenterRegion(pos, CENTER_POS)) {
      return false;
    }

    // If we have a pending placement, check colinearity
    if (state.pendingPlacements.length === 1) {
      return checkColinearityConstraint(state.board, state.pendingPlacements[0], pos, state.currentPlayer);
    }

    return true;
  }

  function canRiftAt(pos: Position): boolean {
    const state = getState();
    if (state.phase !== 'playing' || state.winner || state.aiThinking) {
      return false;
    }
    if (state.gameMode === 'ai-vs-ai') {
      return false;
    }
    const validation = validateRiftConsideringOpening(state, pos);
    return validation.valid;
  }

  function getInvalidPositions(): Set<string> {
    const state = getState();
    if (state.phase !== 'playing' || state.winner) {
      return new Set<string>();
    }
    return computeInvalidPositions(state);
  }

  // NOTE: In ai-vs-ai spectate we must NOT share a single worker across both sides.
  // A shared worker shares TT/move-ordering state between players, which changes behavior vs `vs-ai`.
  // Keep one worker per color so each AI behaves like "AI playing vs human".
  let aiWorkers: { black: Worker | null; white: Worker | null } = { black: null, white: null };

  function terminateAi(): void {
    if (aiWorkers.black) aiWorkers.black.terminate();
    if (aiWorkers.white) aiWorkers.white.terminate();
    aiWorkers = { black: null, white: null };
    ponderingActive = false;
    ponderSignature = null;
    ponderWorkerColor = null;
  }

  function animateAiReinforce(positions: Position[]): void {
    const [first, second] = positions;
    
    // Update board with just the first stone (skip history - we'll record full move later).
    // Preserve any existing scoring highlight until the full move is applied.
    gameStore.placeStones([first], getState().winningLine, true);
    
    // After delay, place second stone and complete the move
    setTimeout(() => {
      const currentState = getState();
      // Cancel if the game is no longer in an active AI animation context.
      if (currentState.phase !== 'playing' || !currentState.aiThinking) {
        return;
      }
      
      const player = currentState.currentPlayer;

      // Create board with both stones to check for scoring.
      const fullBoard = currentState.board.map(row => [...row]);
      fullBoard[second.row][second.col] = player;

      const scoredLines = getScoringLinesForPlacements(fullBoard, positions, player);

      // Apply the full move (records history once).
      gameStore.applyReinforceMove([first, second], scoredLines);
      
      gameStore.setAiThinking(false);
      
      if (scoredLines.length > 0) {
        const after = getState();
        if (after.scoreToWin !== 0 && after.scores[player] >= after.scoreToWin) {
          gameStore.endGame(player, 'score');
          return;
        }
      }
      
      gameStore.switchPlayer();

      // Continue AI-vs-AI autoplay
      const afterSwitch = getState();
      if (maybeEndUnlimitedOnExhaustion()) {
        return;
      }
      if (afterSwitch.phase === 'playing' && afterSwitch.gameMode === 'ai-vs-ai' && !afterSwitch.winner) {
        setTimeout(() => executeAiTurn(), getTurnDelay());
      }
    }, getAnimationDelay());
  }

  function getAiWorker(color: PlayerColor): Worker {
    const existing = aiWorkers[color];
    if (existing) return existing;

    const worker = new Worker(
      new URL('./ai.worker.ts', import.meta.url),
      { type: 'module' }
    );

    worker.onmessage = (e: MessageEvent) => {
      // Worker messages are untyped at runtime; keep this as `any` so we can validate defensively.
      const data = e.data as any;
      const type = data?.type as unknown;
      const move = data?.move as any;
      const resign = data?.resign as any;
      const workerError = data?.error as unknown;
      
      if (type === 'result') {
        if (workerError) {
          console.error('[AI] Worker reported error context', workerError);
        }

        // AI resignation: no fallback; end immediately (but still respect stale-result guards below).
        if (resign && resign.winner) {
          const state = getState();
          // Ignore stale results (e.g., game ended or turn changed while the worker was thinking).
          if (state.phase !== 'playing' || state.endReason !== null) {
            gameStore.setAiThinking(false);
            return;
          }
          if (state.gameMode === 'ai-vs-ai' && state.currentPlayer !== color) {
            gameStore.setAiThinking(false);
            return;
          }
          if (state.gameMode === 'vs-ai' && state.aiColor !== null && state.currentPlayer !== state.aiColor) {
            gameStore.setAiThinking(false);
            return;
          }

          gameStore.setAiThinking(false);
          const winnerColor = getOpponent(state.currentPlayer);
          console.log('[AI] Resigning', { winner: winnerColor, score: resign.score, depth: resign.depth });
          gameStore.endGame(winnerColor, 'resign');
          return;
        }

        const findFallbackReinforce = (state: GameState): Position[] | null => {
          const openingRequiresTwo = isLongProRestrictedBlackSecondMove(state);

          // Long Pro: forced opening move (Black must play center single stone).
          if (isLongProForcedCenterMove(state)) {
            const v = validateReinforceConsideringOpening(state, [CENTER_POS]);
            return v.valid ? [CENTER_POS] : null;
          }

          // Prefer single-stone scoring moves (legal only when it scores).
          if (!openingRequiresTwo) {
            for (let row = 0; row < 15; row++) {
              for (let col = 0; col < 15; col++) {
                const pos = { row, col };
                const v = validateReinforceConsideringOpening(state, [pos]);
                if (v.valid) return [pos];
              }
            }
          }

          const empties: Position[] = [];
          for (let row = 0; row < 15; row++) {
            for (let col = 0; col < 15; col++) {
              const pos = { row, col };
              if (isValidPlacement(state.board, pos, state.lastRiftedPosition)) {
                // Long Pro: forced opening move is handled above.
                if (isLongProRestrictedBlackSecondMove(state) && !isOutsideLongProCenterRegion(pos, CENTER_POS)) {
                  continue;
                }
                empties.push(pos);
              }
            }
          }

          for (let i = 0; i < empties.length; i++) {
            const a = empties[i];
            for (let j = i + 1; j < empties.length; j++) {
              const b = empties[j];
              const v = validateReinforceConsideringOpening(state, [a, b]);
              if (v.valid) return [a, b];
            }
          }

          return null;
        };

        const findFallbackRift = (state: GameState): Position | null => {
          const opponent = getOpponent(state.currentPlayer);
          for (let row = 0; row < 15; row++) {
            for (let col = 0; col < 15; col++) {
              if (state.board[row][col] === opponent) {
                const pos = { row, col };
                const v = validateRiftConsideringOpening(state, pos);
                if (v.valid) return pos;
              }
            }
          }
          return null;
        };

        const tryFallbackAiMove = (state: GameState, message: string, details?: unknown): boolean => {
          // Only recover if this is still an AI-controlled turn for this worker.
          const isAiControlledTurn =
            state.gameMode === 'ai-vs-ai' ||
            (state.gameMode === 'vs-ai' && state.aiColor !== null && state.currentPlayer === state.aiColor);
          const isThisWorkerTurn =
            state.gameMode === 'ai-vs-ai'
              ? state.currentPlayer === color
              : state.gameMode === 'vs-ai' && state.aiColor === color && state.currentPlayer === color;

          if (!isAiControlledTurn || !isThisWorkerTurn) {
            return false;
          }

          // End condition for unlimited (or any mode) if there is truly no legal move.
          const reinforce = findFallbackReinforce(state);
          if (reinforce) {
            console.warn('[AI] Recovering from worker error with fallback reinforce', { message, details, reinforce });
            executeReinforce(reinforce);
            return true;
          }

          const rift = findFallbackRift(state);
          if (rift) {
            console.warn('[AI] Recovering from worker error with fallback rift', { message, details, rift });
            executeRift(rift);
            return true;
          }

          const b = state.scores.black;
          const w = state.scores.white;
          const winner: PlayerColor | null = b === w ? null : b > w ? 'black' : 'white';
          console.warn('[AI] No legal moves available; ending game by exhaustion', { message, details, b, w });
          gameStore.endGame(winner, 'exhaustion');
          return true;
        };

        const failAiMove = (message: string, details?: unknown): void => {
          console.error(message, details);
          gameStore.setAiThinking(false);

          const state = getState();
          if (state.phase !== 'playing' || state.endReason !== null) {
            return;
          }

          // Try to recover automatically (especially important for AI-vs-AI spectate).
          if (tryFallbackAiMove(state, message, details)) {
            return;
          }

          // Fallback: don't leave game in broken state - switch player so human can continue.
          if (!state.winner) {
            gameStore.switchPlayer();
          }
        };

          if (!move) {
            // This should never happen with the improved AI, but handle gracefully
            failAiMove('AI could not find a valid move - this is a bug', workerError);
            return;
          }

          const state = getState();

          // Ignore stale results (e.g., game ended or turn changed while the worker was thinking).
          if (state.phase !== 'playing' || state.endReason !== null) {
            gameStore.setAiThinking(false);
            return;
          }
          if (state.gameMode === 'ai-vs-ai' && state.currentPlayer !== color) {
            gameStore.setAiThinking(false);
            return;
          }
          if (state.gameMode === 'vs-ai' && state.aiColor !== null && state.currentPlayer !== state.aiColor) {
            gameStore.setAiThinking(false);
            return;
          }

          if (!Array.isArray(move.positions)) {
            failAiMove('[AI] Worker returned malformed move (positions is not an array)', move);
            return;
          }

          for (const pos of move.positions) {
            if (!pos || !Number.isInteger(pos.row) || !Number.isInteger(pos.col)) {
              failAiMove('[AI] Worker returned malformed move (invalid position)', move);
              return;
            }
          }

          if (move.action === 'reinforce') {
            const validation = validateReinforceConsideringOpening(state, move.positions);
            if (!validation.valid) {
              failAiMove('[AI] Worker returned illegal reinforce move', { move, reason: validation.reason });
              return;
            }
          } else if (move.action === 'rift') {
            if (move.positions.length !== 1) {
              failAiMove('[AI] Worker returned illegal rift move (must include exactly one position)', move);
              return;
            }
            const validation = validateRiftConsideringOpening(state, move.positions[0]);
            if (!validation.valid) {
              failAiMove('[AI] Worker returned illegal rift move', { move, reason: validation.reason });
              return;
            }
          } else {
            failAiMove('[AI] Worker returned unknown action', move);
            return;
          }

          console.log('[AI] Turn computed', {
            turn: state.moveHistory.length + 1,
            toMove: state.currentPlayer,
            aiColor: state.aiColor,
            workerColor: color,
            action: move.action,
            positions: move.positions,
            nodes: move.nodes,
            depth: move.depth,
            score: move.score,
            timeMs: move.time,
          });

          if (move.ponder) {
            const tt = move.ponder.tt;
            console.log('[AI] Ponder impact', {
              predictedBestOpponentMove: move.ponder.bestMove,
              predictedHit: move.ponder.predictedHit,
              usedReplySession: move.ponder.usedReplySession,
              predictedBestAiReply: move.ponder.replyBestMove,
              ponderReplyBestDepth: move.ponder.replyBestDepth,
              ponderReplyBestScore: move.ponder.replyBestScore,
              ponderReplyNodes: move.ponder.replyNodes,
              ponderReplyTimeMs: move.ponder.replyTimeMs,
              predictedMoveKey: move.ponder.predictedMoveKey,
              ponderNodes: move.ponder.nodes,
              ponderTimeMs: move.ponder.timeMs,
              ponderBestDepth: move.ponder.bestDepth,
              ponderBestScore: move.ponder.bestScore,
              ttHitsFromPonder: tt.hitsPrevAge,
              ttHitsTotal: tt.hits,
              ttReuseFromPonderPct: tt.reuseFromPrevPct,
              ttHitsCurrentAge: tt.hitsCurrentAge,
              ttHitsOtherAges: tt.hitsOtherAge,
            });
          }

        if (move.action === 'reinforce' && move.positions.length === 2) {
          // Animate two-stone placement: show first stone, wait 500ms, then show second
          animateAiReinforce(move.positions);
        } else if (move.action === 'reinforce') {
          // Single stone (winning move)
          gameStore.setAiThinking(false);
          executeReinforce(move.positions);
        } else {
          gameStore.setAiThinking(false);
          executeRift(move.positions[0]);
        }
      }
    };

    aiWorkers[color] = worker;
    return worker;
  }

  function postAiMessage(color: PlayerColor, message: unknown): void {
    getAiWorker(color).postMessage(message);
  }

  // ---- Pondering lifecycle (AI thinks during human turn in worker) ----
  let ponderingActive = false;
  let ponderSignature: string | null = null;
  let ponderWorkerColor: PlayerColor | null = null;

  function computePonderSignature(state: GameState): string {
    const ko = state.lastRiftedPosition ? `${state.lastRiftedPosition.row},${state.lastRiftedPosition.col}` : '-';
    // moveHistory length changes whenever the real board changes
    return `${state.phase}:${state.gameMode}:${state.currentPlayer}:${state.aiColor}:${ko}:${state.moveHistory.length}:${state.winner ?? '-'}`;
  }

  function shouldPonder(state: GameState): boolean {
    if (state.phase !== 'playing') return false;
    if (state.winner) return false;
    if (state.gameMode !== 'vs-ai') return false;
    if (!state.aiColor) return false;
    if (state.aiThinking) return false;
    // Ponder only during human turn
    return state.currentPlayer !== state.aiColor;
  }

  function startPondering(state: GameState): void {
    console.log('[AI] Ponder start', {
      turn: state.moveHistory.length + 1,
      toMove: state.currentPlayer,
      aiColor: state.aiColor,
    });
    const ai = state.aiColor;
    if (!ai) return;
    ponderWorkerColor = ai;
    postAiMessage(ai, {
      type: 'ponderStart',
      state: {
        board: state.board,
        aiColor: state.aiColor,
        playerToMove: state.currentPlayer,
        lastRiftedPosition: state.lastRiftedPosition,
        scores: state.scores,
        scoreToWin: state.scoreToWin,
        openingPreset: state.openingPreset,
        moveIndex: state.moveHistory.length,
      },
      config: {
        sliceMs: 60,
        variant: state.vsAiVariant ?? undefined,
      }
    });
  }

  function stopPondering(): void {
    if (!ponderWorkerColor) return;
    const w = aiWorkers[ponderWorkerColor];
    if (!w) return;
    console.log('[AI] Ponder stop');
    w.postMessage({ type: 'ponderStop' });
  }

  // Subscribe once to keep pondering state in sync with the game.
  gameStore.subscribe(state => {
    const want = shouldPonder(state);
    const sig = computePonderSignature(state);

    if (want) {
      if (!ponderingActive) {
        startPondering(state);
        ponderingActive = true;
        ponderSignature = sig;
      } else if (ponderSignature !== sig) {
        const ai = state.aiColor;
        if (!ai) return;
        postAiMessage(ai, {
          type: 'positionUpdate',
          state: {
            board: state.board,
            aiColor: state.aiColor,
            playerToMove: state.currentPlayer,
            lastRiftedPosition: state.lastRiftedPosition,
            scores: state.scores,
            scoreToWin: state.scoreToWin,
            openingPreset: state.openingPreset,
            moveIndex: state.moveHistory.length,
          },
          config: {
            variant: state.vsAiVariant ?? undefined,
          },
        });
        ponderSignature = sig;
      }
    } else if (ponderingActive) {
      stopPondering();
      ponderingActive = false;
      ponderSignature = null;
      ponderWorkerColor = null;
    }
  });

  function executeAiTurn(): void {
    const state = getState();
    
    if (state.phase !== 'playing' || state.winner) {
      return;
    }

    if (state.aiThinking) return;

    let workerColor: PlayerColor;
    if (state.gameMode === 'ai-vs-ai') {
      workerColor = state.currentPlayer;
    } else if (state.gameMode === 'vs-ai') {
      const ai = state.aiColor;
      if (!ai) return;
      if (state.currentPlayer !== ai) return;
      workerColor = ai;
    } else {
      return;
    }

    gameStore.setAiThinking(true);
    console.log('[AI] Thinking...', {
      turn: state.moveHistory.length + 1,
      toMove: state.currentPlayer,
      aiColor: state.aiColor,
      workerColor,
    });
    
    // Use web worker for AI computation
    const variant =
      state.gameMode === 'ai-vs-ai'
        ? (workerColor === 'black' ? state.spectateVariantBlack : state.spectateVariantWhite)
        : state.gameMode === 'vs-ai'
          ? state.vsAiVariant
          : null;
    postAiMessage(workerColor, {
      type: 'findBestMove',
      state: {
        board: state.board,
        aiColor: workerColor,
        playerToMove: state.currentPlayer,
        lastRiftedPosition: state.lastRiftedPosition,
        scores: state.scores,
        scoreToWin: state.scoreToWin,
        openingPreset: state.openingPreset,
        moveIndex: state.moveHistory.length,
      },
      config:
        state.gameMode === 'ai-vs-ai'
          ? {
              maxTime: workerColor === 'black' ? state.spectateMaxTimeMsBlack : state.spectateMaxTimeMsWhite,
              variant: variant ?? undefined,
            }
          : state.gameMode === 'vs-ai'
            ? { maxTime: state.vsAiMaxTimeMs, variant: variant ?? undefined }
            : undefined
    });
  }

  return {
    handleBoardClick,
    canPlaceAt,
    canRiftAt,
    confirmMove,
    cancelMove,
    executeAiTurn,
    getInvalidPositions,
    terminateAi
  };
}

// Export a singleton engine instance
export const gameEngine = createGameEngine();
