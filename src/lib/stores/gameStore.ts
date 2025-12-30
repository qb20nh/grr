import { writable, derived, get } from 'svelte/store';
import type { GameState, Position, GameMode, Action, PlayerColor, GamePhase } from '$lib/game/types';
import { createEmptyBoard } from '$lib/game/types';
import { wouldWinWithSingleStone } from '$lib/game/validator';

function createInitialState(): GameState {
  return {
    board: createEmptyBoard(),
    currentPlayer: 'black',
    selectedAction: 'reinforce',
    pendingPlacements: [],
    pendingRift: null,
    lastRiftedPosition: null,
    lastPlacedPositions: [],
    winner: null,
    winningLine: null,
    gameMode: 'local',
    aiColor: null,
    phase: 'menu',
    moveHistory: [],
    aiThinking: false
  };
}

function createGameStore() {
  const { subscribe, set, update } = writable<GameState>(createInitialState());

  return {
    subscribe,
    
    startGame(mode: GameMode, playerColor: PlayerColor = 'black') {
      // AI color is opposite of player's color
      const aiColor = mode === 'vs-ai' 
        ? (playerColor === 'black' ? 'white' : 'black') 
        : null;
      
      update(() => ({
        ...createInitialState(),
        gameMode: mode,
        aiColor,
        phase: 'playing'
      }));
    },

    resetGame() {
      set(createInitialState());
    },

    returnToMenu() {
      set(createInitialState());
    },

    restartWithSameSettings() {
      update(state => ({
        ...createInitialState(),
        gameMode: state.gameMode,
        aiColor: state.aiColor,
        phase: 'playing'
      }));
    },

    setAction(action: Action) {
      update(state => ({
        ...state,
        selectedAction: action,
        pendingPlacements: [],
        pendingRift: null
      }));
    },

    addPendingPlacement(pos: Position) {
      update(state => ({
        ...state,
        pendingPlacements: [...state.pendingPlacements, pos],
        pendingRift: null
      }));
    },

    clearPendingPlacements() {
      update(state => ({
        ...state,
        pendingPlacements: [],
        pendingRift: null
      }));
    },

    setPendingRift(pos: Position | null) {
      update(state => ({
        ...state,
        pendingRift: pos,
        pendingPlacements: []
      }));
    },

    placeStones(positions: Position[], winningLine: Position[] | null = null, skipHistory: boolean = false) {
      update(state => {
        const newBoard = state.board.map(row => [...row]);
        positions.forEach(pos => {
          newBoard[pos.row][pos.col] = state.currentPlayer;
        });
        return {
          ...state,
          board: newBoard,
          lastPlacedPositions: positions,
          lastRiftedPosition: null,
          pendingPlacements: [],
          pendingRift: null,
          winningLine,
          // Only add to history if not skipping (used for AI animation)
          moveHistory: skipHistory ? state.moveHistory : [...state.moveHistory, {
            player: state.currentPlayer,
            action: 'reinforce',
            positions
          }]
        };
      });
    },

    removeStone(pos: Position) {
      update(state => {
        const newBoard = state.board.map(row => [...row]);
        newBoard[pos.row][pos.col] = null;
        return {
          ...state,
          board: newBoard,
          lastRiftedPosition: pos,
          lastPlacedPositions: [],
          pendingPlacements: [],
          pendingRift: null,
          moveHistory: [...state.moveHistory, {
            player: state.currentPlayer,
            action: 'rift',
            positions: [],
            removedStone: pos
          }]
        };
      });
    },

    // Record a reinforce move in history without modifying the board
    // Used for AI animation where stones are placed separately but recorded as one move
    recordReinforceMove(positions: Position[]) {
      update(state => ({
        ...state,
        moveHistory: [...state.moveHistory, {
          player: state.currentPlayer,
          action: 'reinforce',
          positions
        }]
      }));
    },

    switchPlayer() {
      update(state => ({
        ...state,
        currentPlayer: state.currentPlayer === 'black' ? 'white' : 'black',
        selectedAction: 'reinforce'
      }));
    },

    setWinner(winner: PlayerColor, winningLine: Position[] | null = null) {
      update(state => ({
        ...state,
        winner,
        winningLine: winningLine || state.winningLine,
        phase: 'ended'
      }));
    },

    setAiThinking(thinking: boolean) {
      update(state => ({
        ...state,
        aiThinking: thinking
      }));
    },

    setPhase(phase: GamePhase) {
      update(state => ({
        ...state,
        phase
      }));
    },

    getState(): GameState {
      return get({ subscribe });
    }
  };
}

export const gameStore = createGameStore();

export const currentPlayer = derived(gameStore, $state => $state.currentPlayer);
export const selectedAction = derived(gameStore, $state => $state.selectedAction);
export const pendingPlacements = derived(gameStore, $state => $state.pendingPlacements);
export const pendingRift = derived(gameStore, $state => $state.pendingRift);
export const gamePhase = derived(gameStore, $state => $state.phase);
export const winner = derived(gameStore, $state => $state.winner);
export const winningLine = derived(gameStore, $state => $state.winningLine);
export const aiThinking = derived(gameStore, $state => $state.aiThinking);
export const isAiTurn = derived(gameStore, $state => 
  $state.phase === 'playing' && 
  $state.gameMode === 'vs-ai' && 
  $state.currentPlayer === $state.aiColor
);

// Derived store that detects what action would happen based on a position
export const canConfirmMove = derived(gameStore, $state => {
  if ($state.phase !== 'playing' || $state.winner) return false;
  if ($state.aiThinking) return false;
  if ($state.gameMode === 'vs-ai' && $state.currentPlayer === $state.aiColor) return false;
  
  // Two stones - always can confirm
  if ($state.pendingPlacements.length === 2) return true;
  
  // Rift - always can confirm
  if ($state.pendingRift !== null) return true;
  
  // Single stone - only if it wins the game
  if ($state.pendingPlacements.length === 1) {
    return wouldWinWithSingleStone($state.board, $state.pendingPlacements[0], $state.currentPlayer);
  }
  
  return false;
});
