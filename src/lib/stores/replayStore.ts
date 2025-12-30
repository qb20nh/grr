/**
 * Replay store for stepping through completed game moves
 */

import { writable, derived, get } from 'svelte/store';
import type { MoveRecord, Stone, Position, PlayerColor } from '$lib/game/types';
import { createEmptyBoard, BOARD_SIZE } from '$lib/game/types';
import { gameStore } from './gameStore';

interface ReplayState {
  active: boolean;
  moveHistory: MoveRecord[];
  currentIndex: number; // 0 = start (empty board), n = after move n
  autoPlayInterval: ReturnType<typeof setInterval> | null;
}

function createReplayStore() {
  const { subscribe, set, update } = writable<ReplayState>({
    active: false,
    moveHistory: [],
    currentIndex: 0,
    autoPlayInterval: null
  });

  /**
   * Reconstruct board state by applying moves up to the given index
   */
  function reconstructBoard(moves: MoveRecord[], upToIndex: number): Stone[][] {
    const board = createEmptyBoard();
    
    for (let i = 0; i < upToIndex && i < moves.length; i++) {
      const move = moves[i];
      
      if (move.action === 'reinforce') {
        for (const pos of move.positions) {
          board[pos.row][pos.col] = move.player;
        }
      } else if (move.action === 'rift' && move.removedStone) {
        board[move.removedStone.row][move.removedStone.col] = null;
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
  } {
    if (index <= 0 || index > moves.length) {
      return { placed: [], removed: null };
    }
    
    const move = moves[index - 1];
    
    if (move.action === 'reinforce') {
      return { placed: move.positions, removed: null };
    } else {
      return { placed: [], removed: move.removedStone ?? null };
    }
  }

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
          autoPlayInterval: null
        };
      });
      
      gameStore.setPhase('ended');
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
      return reconstructBoard(state.moveHistory, state.currentIndex);
    },

    /**
     * Get highlight info for current move
     */
    getHighlights(): { placed: Position[]; removed: Position | null } {
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

// Derived board state for replay
export const replayBoard = derived(replayStore, $state => {
  if (!$state.active) return null;
  
  const board = createEmptyBoard();
  
  for (let i = 0; i < $state.currentIndex && i < $state.moveHistory.length; i++) {
    const move = $state.moveHistory[i];
    
    if (move.action === 'reinforce') {
      for (const pos of move.positions) {
        board[pos.row][pos.col] = move.player;
      }
    } else if (move.action === 'rift' && move.removedStone) {
      board[move.removedStone.row][move.removedStone.col] = null;
    }
  }
  
  return board;
});

// Derived highlights for the current move being viewed
export const replayHighlights = derived(replayStore, $state => {
  if (!$state.active || $state.currentIndex <= 0) {
    return { placed: [] as Position[], removed: null as Position | null };
  }
  
  const move = $state.moveHistory[$state.currentIndex - 1];
  
  if (move.action === 'reinforce') {
    return { placed: move.positions, removed: null as Position | null };
  } else {
    return { placed: [] as Position[], removed: move.removedStone ?? null };
  }
});

