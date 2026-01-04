/**
 * Replay store for stepping through completed game moves
 */

import { writable, derived, get } from 'svelte/store';
import type { MoveRecord, Stone, Position, PlayerColor, OpeningPreset, ScoreToWin, EndReason } from '$lib/game/types';
import { createInitialBoard, BOARD_SIZE, getOpeningFirstPlayer, getOpponent } from '$lib/game/types';
import { flattenUniquePositions } from '$lib/game/scoredLines';
import { computeInvalidPositions } from '$lib/game/invalidPositions';
import { gameStore } from './gameStore';
import type { SaveFileData } from '$lib/game/saveFile';

interface ReplayState {
  active: boolean;
  moveHistory: MoveRecord[];
  currentIndex: number; // 0 = start (empty board), n = after move n
  openingPreset: OpeningPreset;
  autoPlayInterval: ReturnType<typeof setInterval> | null;
}

function getPlayerToMove(openingPreset: OpeningPreset, moveIndex: number): PlayerColor {
  const first = getOpeningFirstPlayer(openingPreset);
  return moveIndex % 2 === 0 ? first : getOpponent(first);
}

function getLastRiftedPosition(moves: MoveRecord[], upToIndex: number): Position | null {
  if (upToIndex <= 0 || upToIndex > moves.length) return null;
  const move = moves[upToIndex - 1];
  return move.action === 'rift' ? move.removedStone ?? null : null;
}

/**
 * Reconstruct board state by applying moves up to the given index
 */
function reconstructBoard(moves: MoveRecord[], upToIndex: number, openingPreset: OpeningPreset): Stone[][] {
  const board = createInitialBoard(openingPreset);

  for (let i = 0; i < upToIndex && i < moves.length; i++) {
    const move = moves[i];

    if (move.action === 'reinforce') {
      for (const pos of move.positions) {
        board[pos.row][pos.col] = move.player;
      }
    } else if (move.action === 'rift' && move.removedStone) {
      board[move.removedStone.row][move.removedStone.col] = null;
    }

    if (move.scoredLines) {
      for (const line of move.scoredLines) {
        for (const pos of line) {
          if (pos.row < 0 || pos.row >= BOARD_SIZE || pos.col < 0 || pos.col >= BOARD_SIZE) continue;
          board[pos.row][pos.col] = null;
        }
      }
    }
  }

  return board;
}

/**
 * Get the positions affected by the move at the given index (for highlighting)
 */
function getMoveHighlights(moves: MoveRecord[], index: number): {
  placed: Position[];
  removed: Position | null;
  winningLine: Position[] | null;
  winningLineBy: PlayerColor | null;
} {
  if (index <= 0 || index > moves.length) {
    return { placed: [], removed: null, winningLine: null, winningLineBy: null };
  }

  const move = moves[index - 1];

  let winningLine: Position[] | null = null;
  let winningLineBy: PlayerColor | null = null;
  if (move.scoredLines && move.scoredLines.length > 0) {
    winningLine = flattenUniquePositions(move.scoredLines);
    winningLineBy = move.scoredBy ?? move.player;
  }

  if (move.action === 'reinforce') {
    return { placed: move.positions, removed: null, winningLine, winningLineBy };
  } else {
    return { placed: [], removed: move.removedStone ?? null, winningLine, winningLineBy };
  }
}

function createReplayStore() {
  const { subscribe, set, update } = writable<ReplayState>({
    active: false,
    moveHistory: [],
    currentIndex: 0,
    openingPreset: 'long-pro',
    autoPlayInterval: null
  });

  // Keep replay state consistent with the main game phase.
  // If the game leaves replay (e.g., returning to menu / starting a new game) without
  // explicitly calling `exitReplay()`, we must still clear replay UI state and stop autoplay.
  gameStore.subscribe(game => {
    if (game.phase === 'replay') return;
    update(state => {
      // Fast path: already reset
      if (!state.active && state.autoPlayInterval === null && state.moveHistory.length === 0 && state.currentIndex === 0) {
        return state;
      }
      if (state.autoPlayInterval) {
        clearInterval(state.autoPlayInterval);
      }
      return {
        active: false,
        moveHistory: [],
        currentIndex: 0,
        openingPreset: 'long-pro',
        autoPlayInterval: null
      };
    });
  });

  return {
    subscribe,

    /**
     * Enter replay mode with the current game's move history
     */
    enterReplay() {
      const gameState = gameStore.getState();
      
      update(state => {
        // Clear any existing autoplay
        if (state.autoPlayInterval) {
          clearInterval(state.autoPlayInterval);
        }
        
        return {
          active: true,
          moveHistory: [...gameState.moveHistory],
          currentIndex: 0, // Start at beginning
          openingPreset: gameState.openingPreset,
          autoPlayInterval: null
        };
      });
      
      // Update game phase to replay
      gameStore.setPhase('replay');
    },

    /**
     * Exit replay mode and return to ended state
     */
    exitReplay() {
      update(state => {
        if (state.autoPlayInterval) {
          clearInterval(state.autoPlayInterval);
        }
        return {
          active: false,
          moveHistory: [],
          currentIndex: 0,
          openingPreset: 'long-pro',
          autoPlayInterval: null
        };
      });
      
      gameStore.setPhase('ended');
    },

    /**
     * Enter replay mode from an imported save file
     */
    enterReplayFromSave(save: SaveFileData) {
      update(state => {
        if (state.autoPlayInterval) {
          clearInterval(state.autoPlayInterval);
        }
        return {
          active: true,
          moveHistory: [...save.moves],
          currentIndex: 0,
          openingPreset: save.metadata.opening,
          autoPlayInterval: null
        };
      });

      // Set up gameStore for replay display
      gameStore.loadForReplay({
        openingPreset: save.metadata.opening,
        winner: save.metadata.winner,
        endReason: save.metadata.endReason,
        scores: save.metadata.scores,
        scoreToWin: save.metadata.scoreToWin,
        moveHistory: save.moves,
      });
    },

    /**
     * Jump to the start (empty board)
     */
    first() {
      update(state => ({ ...state, currentIndex: 0 }));
    },

    /**
     * Go back one move
     */
    prev() {
      update(state => ({
        ...state,
        currentIndex: Math.max(0, state.currentIndex - 1)
      }));
    },

    /**
     * Go forward one move
     */
    next() {
      update(state => ({
        ...state,
        currentIndex: Math.min(state.moveHistory.length, state.currentIndex + 1)
      }));
    },

    /**
     * Jump to the end (final state)
     */
    last() {
      update(state => ({
        ...state,
        currentIndex: state.moveHistory.length
      }));
    },

    /**
     * Jump to a specific move index
     */
    goTo(index: number) {
      update(state => ({
        ...state,
        currentIndex: Math.max(0, Math.min(state.moveHistory.length, index))
      }));
    },

    /**
     * Toggle autoplay (step through moves automatically)
     */
    toggleAutoPlay(intervalMs: number = 1000) {
      update(state => {
        if (state.autoPlayInterval) {
          clearInterval(state.autoPlayInterval);
          return { ...state, autoPlayInterval: null };
        }
        
        const interval = setInterval(() => {
          update(s => {
            if (s.currentIndex >= s.moveHistory.length) {
              clearInterval(s.autoPlayInterval!);
              return { ...s, autoPlayInterval: null };
            }
            return { ...s, currentIndex: s.currentIndex + 1 };
          });
        }, intervalMs);
        
        return { ...state, autoPlayInterval: interval };
      });
    },

    /**
     * Check if autoplay is active
     */
    isAutoPlaying(): boolean {
      return get({ subscribe }).autoPlayInterval !== null;
    },

    /**
     * Get the reconstructed board at current index
     */
    getBoard(): Stone[][] {
      const state = get({ subscribe });
      return reconstructBoard(state.moveHistory, state.currentIndex, state.openingPreset);
    },

    /**
     * Get highlight info for current move
     */
    getHighlights(): { placed: Position[]; removed: Position | null; winningLine: Position[] | null; winningLineBy: PlayerColor | null } {
      const state = get({ subscribe });
      return getMoveHighlights(state.moveHistory, state.currentIndex);
    },

    /**
     * Get the player of the current move (if any)
     */
    getCurrentMovePlayer(): PlayerColor | null {
      const state = get({ subscribe });
      if (state.currentIndex <= 0 || state.currentIndex > state.moveHistory.length) {
        return null;
      }
      return state.moveHistory[state.currentIndex - 1].player;
    }
  };
}

export const replayStore = createReplayStore();

// Derived stores for reactive UI
export const isReplaying = derived(replayStore, $state => $state.active);
export const replayIndex = derived(replayStore, $state => $state.currentIndex);
export const replayMoveCount = derived(replayStore, $state => $state.moveHistory.length);
export const isAutoPlaying = derived(replayStore, $state => $state.autoPlayInterval !== null);

export const replayPlayerToMove = derived(replayStore, $state => {
  if (!$state.active) return null;
  return getPlayerToMove($state.openingPreset, $state.currentIndex);
});

// Derived board state for replay
export const replayBoard = derived(replayStore, $state => {
  if (!$state.active) return null;
  return reconstructBoard($state.moveHistory, $state.currentIndex, $state.openingPreset);
});

// Derived highlights for the current move being viewed
export const replayHighlights = derived(replayStore, $state => {
  if (!$state.active) {
    return { placed: [] as Position[], removed: null as Position | null, winningLine: null as Position[] | null, winningLineBy: null as PlayerColor | null };
  }
  return getMoveHighlights($state.moveHistory, $state.currentIndex);
});

export const replayInvalidPositions = derived([replayStore, replayBoard], ([$state, board]) => {
  if (!$state.active || !board) return new Set<string>();

  const moveHistory = $state.moveHistory.slice(0, $state.currentIndex);
  const currentPlayer = getPlayerToMove($state.openingPreset, $state.currentIndex);
  const lastRiftedPosition = getLastRiftedPosition($state.moveHistory, $state.currentIndex);

  return computeInvalidPositions({
    board,
    currentPlayer,
    openingPreset: $state.openingPreset,
    moveHistory,
    pendingPlacements: [],
    lastRiftedPosition,
  });
});

