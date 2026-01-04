<script lang="ts">
  import { onMount } from 'svelte';
  import { gameStore, pendingPlacements, pendingRift, winningLine, isAiTurn, gamePhase, aiThinking } from '$lib/stores/gameStore';
  import { isReplaying, replayBoard, replayHighlights, replayInvalidPositions, replayPlayerToMove } from '$lib/stores/replayStore';
  import { gameEngine, isFastMode } from '$lib/game/engine';
  import { setupCanvas, renderBoard, getCursorStyle } from '$lib/utils/canvas';
  import type { Position, PlayerColor } from '$lib/game/types';
  import { BOARD_SIZE } from '$lib/game/types';

  const MIN_CELL_SIZE = 22;
  const MAX_CELL_SIZE = 36;
  const PADDING = 20;

  let canvas: HTMLCanvasElement;
  let ctx: CanvasRenderingContext2D;
  let hoverPosition: Position | null = $state(null);
  let cursorStyle = $state('crosshair');
  let cellSize = $state(MAX_CELL_SIZE);
  let touchStart: { x: number; y: number } | null = null;
  let touchMoved = $state(false);

  function calculateCellSize(): number {
    if (typeof window === 'undefined') return MAX_CELL_SIZE;
    const maxDim = Math.min(window.innerWidth, window.innerHeight);
    // Leave room for padding and some margin
    const available = maxDim - PADDING * 2 - 40;
    const calculated = Math.floor(available / (BOARD_SIZE - 1));
    return Math.max(MIN_CELL_SIZE, Math.min(MAX_CELL_SIZE, calculated));
  }

  function resizeBoard() {
    const newSize = calculateCellSize();
    if (newSize !== cellSize) {
      cellSize = newSize;
      if (canvas && ctx) {
        ctx = setupCanvas(canvas, cellSize, PADDING);
        render();
      }
    }
  }

  onMount(() => {
    cellSize = calculateCellSize();
    ctx = setupCanvas(canvas, cellSize, PADDING);
    render();
    
    // Listen for resize
    window.addEventListener('resize', resizeBoard);

    return () => {
      window.removeEventListener('resize', resizeBoard);
    };
  });

  // Trigger AI on new game when AI plays first
  let prevPhase = '';
  $effect(() => {
    const state = $gameStore;
    const phase = state.phase;
    
    // Detect transition TO 'playing' phase with empty board (new game start)
    const isNewGameStart = phase === 'playing' && prevPhase !== 'playing' && state.moveHistory.length === 0;
    prevPhase = phase;
    
    // Trigger AI if it's a new game and an AI-controlled side is to move
    if (isNewGameStart && 
        (state.gameMode === 'ai-vs-ai' || (state.gameMode === 'vs-ai' && state.currentPlayer === state.aiColor)) && 
        !state.aiThinking) {
      setTimeout(() => gameEngine.executeAiTurn(), isFastMode() ? 0 : 500);
    }
  });

  // Re-render when game state changes
  $effect(() => {
    if (!ctx) return;

    void $gameStore;
    void $pendingPlacements;
    void $pendingRift;
    void $winningLine;
    void $isReplaying;
    void $replayBoard;
    void $replayHighlights;
    void $replayInvalidPositions;
    void $replayPlayerToMove;

    render();
  });

  // Update cursor based on hover position
  $effect(() => {
    if (!canvas) return;
    
    const state = $gameStore;
    const aiTurn = $isAiTurn;
    
    if (state.aiThinking) {
      cursorStyle = 'wait';
      return;
    }
    
    if (state.phase === 'replay' || aiTurn) {
      cursorStyle = 'default';
      return;
    }
    
    const invalidPositions = gameEngine.getInvalidPositions();
    
    cursorStyle = getCursorStyle(
      hoverPosition,
      state.board,
      state.currentPlayer,
      state.lastRiftedPosition,
      invalidPositions,
      state.phase === 'ended'
    );
  });

  function render() {
    if (!ctx) return;
    
    const state = gameStore.getState();
    const replaying = state.phase === 'replay';
    
    if (replaying) {
      const board = $replayBoard;
      const highlights = $replayHighlights;
      const currentPlayer = $replayPlayerToMove ?? 'black';
      const invalidPositions = $replayInvalidPositions;

      if (!board) return;
      
      renderBoard(ctx, {
        cellSize,
        padding: PADDING,
        board,
        pendingPlacements: [],
        pendingRift: null,
        lastPlacedPositions: highlights.placed,
        lastRiftedPosition: highlights.removed,
        currentPlayer,
        hoverPosition: null,
        winningLine: highlights.winningLine,
        winningLineBy: highlights.winningLineBy,
        invalidPositions,
        gameEnded: false
      });
    } else {
      const invalidPositions = gameEngine.getInvalidPositions();
      // Hide hover when AI's turn or AI is thinking
      const isAisTurn = state.gameMode === 'ai-vs-ai' || (state.gameMode === 'vs-ai' && state.currentPlayer === state.aiColor);
      const showHover = !state.aiThinking && !isAisTurn;

      let winningLineBy: PlayerColor | null = null;
      if (state.winningLine && state.moveHistory.length > 0) {
        const lastMove = state.moveHistory[state.moveHistory.length - 1];
        winningLineBy = lastMove.scoredBy ?? lastMove.player;
      }
      
      renderBoard(ctx, {
        cellSize,
        padding: PADDING,
        board: state.board,
        pendingPlacements: state.pendingPlacements,
        pendingRift: state.pendingRift,
        lastPlacedPositions: state.lastPlacedPositions,
        lastRiftedPosition: state.lastRiftedPosition,
        currentPlayer: state.currentPlayer,
        hoverPosition: showHover ? hoverPosition : null,
        winningLine: state.winningLine,
        winningLineBy,
        invalidPositions,
        gameEnded: state.phase === 'ended'
      });
    }
  }

  function getBoardPositionFromCoords(clientX: number, clientY: number): Position | null {
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const col = Math.round((x - PADDING) / cellSize);
    const row = Math.round((y - PADDING) / cellSize);
    if (row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE) {
      return { row, col };
    }
    return null;
  }

  function handleMouseMove(event: MouseEvent) {
    const pos = getBoardPositionFromCoords(event.clientX, event.clientY);
    if (pos?.row !== hoverPosition?.row || pos?.col !== hoverPosition?.col) {
      hoverPosition = pos;
      render();
    }
  }

  function handleMouseLeave() {
    hoverPosition = null;
    render();
  }

  function handleClick(event: MouseEvent) {
    const state = gameStore.getState();
    if (state.phase === 'replay') return;
    
    const pos = getBoardPositionFromCoords(event.clientX, event.clientY);
    if (pos) {
      gameEngine.handleBoardClick(pos);
    }
  }

  function handleTouchEnd(event: TouchEvent) {
    const state = gameStore.getState();
    if (state.phase === 'replay') return;
    
    const touch = event.changedTouches[0];
    if (!touch) return;

    // If the finger moved, treat this as a scroll gesture and do not place.
    if (touchMoved) {
      touchStart = null;
      touchMoved = false;
      return;
    }
    // Tap: prevent the synthetic click and handle as a board action.
    event.preventDefault();
    
    const pos = getBoardPositionFromCoords(touch.clientX, touch.clientY);
    if (pos) {
      gameEngine.handleBoardClick(pos);
    }
    
    // Clear hover on touch
    hoverPosition = null;
    render();
  }

  function handleTouchStart(event: TouchEvent) {
    const touch = event.touches[0];
    if (!touch) return;
    touchStart = { x: touch.clientX, y: touch.clientY };
    touchMoved = false;
  }

  function handleTouchMove(event: TouchEvent) {
    const touch = event.touches[0];
    if (!touch || !touchStart) return;
    const dx = touch.clientX - touchStart.x;
    const dy = touch.clientY - touchStart.y;
    // Threshold to distinguish tap vs scroll.
    if (dx * dx + dy * dy > 12 * 12) {
      touchMoved = true;
    }
  }
</script>

<div class="board-container">
  <canvas
    bind:this={canvas}
    onmousemove={handleMouseMove}
    onmouseleave={handleMouseLeave}
    onclick={handleClick}
    ontouchstart={handleTouchStart}
    ontouchmove={handleTouchMove}
    ontouchend={handleTouchEnd}
    style:cursor={cursorStyle}
    style:touch-action="pan-y"
    role="grid"
    aria-label="Gomoku game board"
  ></canvas>
</div>

<style>
  .board-container {
    display: flex;
    justify-content: center;
    align-items: center;
    padding: 8px;
  }

  canvas {
    border-radius: 8px;
    box-shadow: 
      0 2px 12px rgba(0, 0, 0, 0.4),
      0 0 30px rgba(0, 217, 255, 0.08);
  }
</style>
