import type { Position, GameState } from './types';
import { positionsEqual, getOpponent } from './types';
import { gameStore } from '$lib/stores/gameStore';
import { validateReinforceAction, validateRiftAction, isValidPlacement, checkColinearityConstraint, wouldWinWithSingleStone } from './validator';
import { scanBoardForWin, getWinningLine } from './winChecker';

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

  function handleBoardClick(pos: Position): void {
    const state = getState();
    
    if (state.phase !== 'playing' || state.winner) {
      return;
    }

    // If AI is thinking, ignore clicks
    if (state.aiThinking) {
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
    
    const validation = validateRiftAction(state.board, pos, state.currentPlayer);
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

    if (state.pendingPlacements.length === 2) {
      executeReinforce(state.pendingPlacements);
    } else if (state.pendingPlacements.length === 1) {
      // Single stone - only allowed if it wins
      const pos = state.pendingPlacements[0];
      if (wouldWinWithSingleStone(state.board, pos, state.currentPlayer)) {
        executeReinforce(state.pendingPlacements);
      }
    } else if (state.pendingRift) {
      executeRift(state.pendingRift);
    }
  }

  function cancelMove(): void {
    gameStore.clearPendingPlacements();
  }

  function executeReinforce(positions: Position[]): void {
    const state = getState();
    
    const validation = validateReinforceAction(
      state.board,
      positions,
      state.currentPlayer,
      state.lastRiftedPosition
    );

    if (!validation.valid) {
      return;
    }

    // Create temp board to check for win
    const tempBoard = state.board.map(row => [...row]);
    positions.forEach(pos => {
      tempBoard[pos.row][pos.col] = state.currentPlayer;
    });

    // Check for win and get winning line
    let winLine: Position[] | null = null;
    for (const pos of positions) {
      winLine = getWinningLine(tempBoard, pos, state.currentPlayer);
      if (winLine) break;
    }

    gameStore.placeStones(positions, winLine);
    
    if (winLine) {
      gameStore.setWinner(state.currentPlayer, winLine);
      return;
    }

    // Single stone placement without win is invalid (shouldn't reach here due to validation)
    if (positions.length === 1) {
      console.warn('Single stone placement without win - this should not happen');
      return;
    }

    gameStore.switchPlayer();
    
    // Trigger AI if needed
    const updatedState = getState();
    if (updatedState.gameMode === 'vs-ai' && updatedState.currentPlayer === updatedState.aiColor) {
      setTimeout(() => executeAiTurn(), 300);
    }
  }

  function executeRift(pos: Position): void {
    const state = getState();
    
    gameStore.removeStone(pos);
    
    // Check if removing a stone revealed a winning line
    const newState = getState();
    const winner = scanBoardForWin(newState.board);
    if (winner) {
      // Find the winning line
      let winLine: Position[] | null = null;
      for (let row = 0; row < 15; row++) {
        for (let col = 0; col < 15; col++) {
          if (newState.board[row][col] === winner) {
            winLine = getWinningLine(newState.board, { row, col }, winner);
            if (winLine) break;
          }
        }
        if (winLine) break;
      }
      gameStore.setWinner(winner, winLine);
      return;
    }

    gameStore.switchPlayer();
    
    // Trigger AI if needed
    const updatedState = getState();
    if (updatedState.gameMode === 'vs-ai' && updatedState.currentPlayer === updatedState.aiColor) {
      setTimeout(() => executeAiTurn(), 300);
    }
  }

  function canPlaceAt(pos: Position): boolean {
    const state = getState();
    
    if (state.phase !== 'playing' || state.winner || state.aiThinking) {
      return false;
    }

    if (!isValidPlacement(state.board, pos, state.lastRiftedPosition)) {
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
    const validation = validateRiftAction(state.board, pos, state.currentPlayer);
    return validation.valid;
  }

  function getInvalidPositions(): Set<string> {
    const state = getState();
    const invalid = new Set<string>();
    
    if (state.phase !== 'playing' || state.winner) {
      return invalid;
    }

    // When we have one pending placement, mark colinearity-invalid positions
    if (state.pendingPlacements.length === 1) {
      const firstPos = state.pendingPlacements[0];
      for (let row = 0; row < 15; row++) {
        for (let col = 0; col < 15; col++) {
          const pos = { row, col };
          if (state.board[row][col] === null && 
              !positionsEqual(pos, state.lastRiftedPosition) &&
              !positionsEqual(pos, firstPos)) {
            if (!checkColinearityConstraint(state.board, firstPos, pos, state.currentPlayer)) {
              invalid.add(`${row},${col}`);
            }
          }
        }
      }
    }

    // Mark Ko-blocked position
    if (state.lastRiftedPosition) {
      invalid.add(`${state.lastRiftedPosition.row},${state.lastRiftedPosition.col}`);
    }

    return invalid;
  }

  let aiWorker: Worker | null = null;
  const AI_STONE_DELAY = 500; // ms between first and second stone placement

  function terminateAi(): void {
    if (aiWorker) {
      aiWorker.terminate();
      aiWorker = null;
    }
    ponderingActive = false;
    ponderSignature = null;
  }

  function animateAiReinforce(positions: Position[]): void {
    const [first, second] = positions;
    
    // Update board with just the first stone (skip history - we'll record full move later)
    gameStore.placeStones([first], null, true);
    
    // After delay, place second stone and complete the move
    setTimeout(() => {
      const currentState = getState();
      
      // Create board with both stones to check for win
      const fullBoard = currentState.board.map(row => [...row]);
      fullBoard[second.row][second.col] = currentState.currentPlayer;
      
      // Check for win
      let winLine: Position[] | null = null;
      for (const pos of positions) {
        winLine = getWinningLine(fullBoard, pos, currentState.currentPlayer);
        if (winLine) break;
      }
      
      // Place second stone and update highlight to include BOTH stones (skip history - we'll record full move below)
      gameStore.placeStones([first, second], winLine, true);
      
      // Now record the FULL two-stone move in history
      gameStore.recordReinforceMove(positions);
      
      gameStore.setAiThinking(false);
      
      if (winLine) {
        gameStore.setWinner(currentState.currentPlayer, winLine);
        return;
      }
      
      gameStore.switchPlayer();
    }, AI_STONE_DELAY);
  }

  function getAiWorker(): Worker {
    if (!aiWorker) {
      aiWorker = new Worker(
        new URL('./ai.worker.ts', import.meta.url),
        { type: 'module' }
      );
      
      aiWorker.onmessage = (e: MessageEvent) => {
        const { type, move } = e.data;
        
        if (type === 'result') {
          if (!move) {
            gameStore.setAiThinking(false);
            // This should never happen with the improved AI, but handle gracefully
            console.error('AI could not find a valid move - this is a bug');
            // Don't leave game in broken state - switch player so human can continue
            const state = getState();
            if (state.phase === 'playing' && !state.winner) {
              gameStore.switchPlayer();
            }
            return;
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
    }
    return aiWorker;
  }

  function postAiMessage(message: unknown): void {
    const worker = getAiWorker();
    worker.postMessage(message);
  }

  // ---- Pondering lifecycle (AI thinks during human turn in worker) ----
  let ponderingActive = false;
  let ponderSignature: string | null = null;

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
    postAiMessage({
      type: 'ponderStart',
      state: {
        board: state.board,
        aiColor: state.aiColor,
        playerToMove: state.currentPlayer,
        lastRiftedPosition: state.lastRiftedPosition
      },
      config: {
        sliceMs: 60
      }
    });
  }

  function stopPondering(): void {
    if (!aiWorker) return;
    aiWorker.postMessage({ type: 'ponderStop' });
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
        postAiMessage({
          type: 'positionUpdate',
          state: {
            board: state.board,
            aiColor: state.aiColor,
            playerToMove: state.currentPlayer,
            lastRiftedPosition: state.lastRiftedPosition
          }
        });
        ponderSignature = sig;
      }
    } else if (ponderingActive) {
      stopPondering();
      ponderingActive = false;
      ponderSignature = null;
    }
  });

  function executeAiTurn(): void {
    const state = getState();
    
    if (state.phase !== 'playing' || state.winner) {
      return;
    }

    if (state.currentPlayer !== state.aiColor) {
      return;
    }

    gameStore.setAiThinking(true);
    
    // Use web worker for AI computation
    postAiMessage({
      type: 'findBestMove',
      state: {
        board: state.board,
        aiColor: state.aiColor,
        playerToMove: state.currentPlayer,
        lastRiftedPosition: state.lastRiftedPosition
      }
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
