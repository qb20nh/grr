import { writable, derived, get } from 'svelte/store';
import type { GameState, Position, GameMode, Action, PlayerColor, GamePhase, ScoreToWin, EndReason, OpeningPreset } from '$lib/game/types';
import { createInitialBoard, getOpeningFirstPlayer, BOARD_SIZE } from '$lib/game/types';
import { flattenUniquePositions } from '$lib/game/scoredLines';
import { wouldScoreWithSingleStone } from '$lib/game/validator';
import { isLongProForcedCenterMove } from '$lib/game/openingRules';

function clearScoredLinesInPlace(board: GameState['board'], scoredLines: Position[][]): void {
  if (scoredLines.length === 0) return;

  const toClear = new Set<number>();
  for (const line of scoredLines) {
    for (const pos of line) {
      if (pos.row < 0 || pos.row >= BOARD_SIZE || pos.col < 0 || pos.col >= BOARD_SIZE) continue;
      toClear.add(pos.row * BOARD_SIZE + pos.col);
    }
  }

  for (const idx of toClear) {
    const row = Math.floor(idx / BOARD_SIZE);
    const col = idx % BOARD_SIZE;
    board[row][col] = null;
  }
}

function createInitialState(openingPreset: OpeningPreset = 'long-pro'): GameState {
  return {
    board: createInitialBoard(openingPreset),
    currentPlayer: getOpeningFirstPlayer(openingPreset),
    selectedAction: 'reinforce',
    pendingPlacements: [],
    pendingRift: null,
    lastRiftedPosition: null,
    lastPlacedPositions: [],
    winner: null,
    winningLine: null,
    scores: { black: 0, white: 0 }, // match points
    scoreToWin: 1,
    openingPreset,
    endReason: null,
    gameMode: 'local',
    aiColor: null,
    vsAiMaxTimeMs: 5000,
    spectateMaxTimeMsBlack: 5000,
    spectateMaxTimeMsWhite: 5000,
    phase: 'menu',
    moveHistory: [],
    aiThinking: false
  };
}

function createGameStore() {
  const { subscribe, set, update } = writable<GameState>(createInitialState());

  function normalizeAiTimeMs(value: unknown, fallback: number): number {
    if (typeof value !== 'number') return fallback;
    if (!Number.isFinite(value) || value < 0) return fallback;
    if (value === 0) return 0; // Ultra (special long search)
    return Math.floor(value);
  }

  function normalizeOpeningPreset(value: unknown, fallback: OpeningPreset): OpeningPreset {
    if (value === 'long-pro' || value === 'standard-empty' || value === 'legacy-black-center-white-first') {
      return value;
    }
    return fallback;
  }

  function startGame(mode: 'local', scoreToWin?: ScoreToWin): void;
  function startGame(mode: 'local', scoreToWin?: ScoreToWin, openingPreset?: OpeningPreset): void;
  function startGame(mode: 'vs-ai', playerColor: PlayerColor, scoreToWin?: ScoreToWin, aiMaxTimeMs?: number, openingPreset?: OpeningPreset): void;
  function startGame(mode: 'ai-vs-ai', blackMaxTimeMs?: number, whiteMaxTimeMs?: number, scoreToWin?: ScoreToWin, openingPreset?: OpeningPreset): void;
  function startGame(mode: GameMode, arg1?: unknown, arg2?: unknown, arg3?: unknown, arg4?: unknown): void {
    // AI color is opposite of player's color
    const aiColor =
      mode === 'vs-ai'
        ? ((typeof arg1 === 'string' ? arg1 : 'black') === 'black' ? 'white' : 'black')
        : null;

    const vsAiMaxTimeMs =
      mode === 'vs-ai' ? normalizeAiTimeMs(arg3, 5000) : 5000;

    const spectateMaxTimeMsBlack =
      mode === 'ai-vs-ai' ? normalizeAiTimeMs(arg1, 5000) : 5000;
    const spectateMaxTimeMsWhite =
      mode === 'ai-vs-ai' ? normalizeAiTimeMs(arg2 ?? arg1, 5000) : 5000;

    const scoreToWin: ScoreToWin =
      mode === 'local'
        ? (typeof arg1 === 'number' ? (arg1 as ScoreToWin) : 1)
        : mode === 'vs-ai'
          ? (typeof arg2 === 'number' ? (arg2 as ScoreToWin) : 1)
          : mode === 'ai-vs-ai'
            ? (typeof arg3 === 'number' ? (arg3 as ScoreToWin) : 1)
            : 1;

    const openingPreset: OpeningPreset =
      mode === 'local'
        ? normalizeOpeningPreset(arg2, 'long-pro')
        : mode === 'vs-ai'
          ? normalizeOpeningPreset(arg4, 'long-pro')
          : mode === 'ai-vs-ai'
            ? normalizeOpeningPreset(arg4, 'long-pro')
            : 'long-pro';

    update(() => ({
      ...createInitialState(openingPreset),
      gameMode: mode,
      aiColor,
      vsAiMaxTimeMs,
      spectateMaxTimeMsBlack,
      spectateMaxTimeMsWhite,
      scoreToWin,
      phase: 'playing'
    }));
  }

  return {
    subscribe,
    
    startGame,

    resetGame() {
      set(createInitialState());
    },

    returnToMenu() {
      set(createInitialState());
    },

    restartWithSameSettings() {
      update(state => ({
        ...createInitialState(state.openingPreset),
        gameMode: state.gameMode,
        aiColor: state.aiColor,
        vsAiMaxTimeMs: state.vsAiMaxTimeMs,
        spectateMaxTimeMsBlack: state.spectateMaxTimeMsBlack,
        spectateMaxTimeMsWhite: state.spectateMaxTimeMsWhite,
        scoreToWin: state.scoreToWin,
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

    applyReinforceMove(
      positions: Position[],
      scoredLines: Position[][],
      skipHistory: boolean = false
    ) {
      update(state => {
        const newBoard = state.board.map(row => [...row]);
        for (const pos of positions) {
          newBoard[pos.row][pos.col] = state.currentPlayer;
        }

        clearScoredLinesInPlace(newBoard, scoredLines);

        const scoredBy = scoredLines.length > 0 ? state.currentPlayer : undefined;
        const winningLine = scoredLines.length > 0 ? flattenUniquePositions(scoredLines) : null;
        const nextScores = { ...state.scores };
        if (scoredBy) {
          nextScores[scoredBy] += scoredLines.length;
        }

        return {
          ...state,
          board: newBoard,
          lastPlacedPositions: positions,
          lastRiftedPosition: null,
          pendingPlacements: [],
          pendingRift: null,
          winningLine,
          scores: nextScores,
          // Only add to history if not skipping (used for AI animation)
          moveHistory: skipHistory
            ? state.moveHistory
            : [
                ...state.moveHistory,
                {
                  player: state.currentPlayer,
                  action: 'reinforce',
                  positions,
                  ...(scoredBy ? { scoredBy, scoredLines } : {})
                }
              ]
        };
      });
    },

    applyRiftMove(
      removedStone: Position,
      scoredBy: PlayerColor | null,
      scoredLines: Position[][],
      skipHistory: boolean = false
    ) {
      update(state => {
        const newBoard = state.board.map(row => [...row]);
        newBoard[removedStone.row][removedStone.col] = null;

        clearScoredLinesInPlace(newBoard, scoredLines);

        const winningLine = scoredLines.length > 0 ? flattenUniquePositions(scoredLines) : null;
        const nextScores = { ...state.scores };
        if (scoredBy && scoredLines.length > 0) {
          nextScores[scoredBy] += scoredLines.length;
        }

        return {
          ...state,
          board: newBoard,
          lastRiftedPosition: removedStone,
          lastPlacedPositions: [],
          pendingPlacements: [],
          pendingRift: null,
          winningLine,
          scores: nextScores,
          moveHistory: skipHistory
            ? state.moveHistory
            : [
                ...state.moveHistory,
                {
                  player: state.currentPlayer,
                  action: 'rift',
                  positions: [],
                  removedStone,
                  ...(scoredBy && scoredLines.length > 0 ? { scoredBy, scoredLines } : {})
                }
              ]
        };
      });
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
        endReason: state.endReason ?? 'score',
        phase: 'ended'
      }));
    },

    endGame(winner: PlayerColor | null, reason: Exclude<EndReason, null>, winningLine: Position[] | null = null) {
      update(state => ({
        ...state,
        winner,
        winningLine: winningLine || state.winningLine,
        endReason: reason,
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
  (
    ($state.gameMode === 'vs-ai' && $state.currentPlayer === $state.aiColor) ||
    $state.gameMode === 'ai-vs-ai'
  )
);

// Derived store that detects what action would happen based on a position
export const canConfirmMove = derived(gameStore, $state => {
  if ($state.phase !== 'playing' || $state.winner) return false;
  if ($state.aiThinking) return false;
  if ($state.gameMode === 'ai-vs-ai') return false;
  if ($state.gameMode === 'vs-ai' && $state.currentPlayer === $state.aiColor) return false;
  
  // Two stones - always can confirm
  if ($state.pendingPlacements.length === 2) return true;
  
  // Rift - always can confirm
  if ($state.pendingRift !== null) return true;
  
  // Single stone - only if it scores
  if ($state.pendingPlacements.length === 1) {
    if (isLongProForcedCenterMove($state)) return true;
    return wouldScoreWithSingleStone($state.board, $state.pendingPlacements[0], $state.currentPlayer);
  }
  
  return false;
});
