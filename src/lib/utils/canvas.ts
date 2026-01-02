import type { Stone, Position, PlayerColor } from '$lib/game/types';
import { BOARD_SIZE, positionsEqual } from '$lib/game/types';

export interface BoardRenderOptions {
  cellSize: number;
  padding: number;
  board: Stone[][];
  pendingPlacements: Position[];
  pendingRift: Position | null;
  lastPlacedPositions: Position[];
  lastRiftedPosition: Position | null;
  currentPlayer: PlayerColor;
  hoverPosition: Position | null;
  winningLine: Position[] | null;
  /**
   * When `winningLine` represents cleared scoring stones, this indicates which player's stones
   * were cleared (used to color the inner dashed outline).
   */
  winningLineBy?: PlayerColor | null;
  invalidPositions: Set<string>;
  gameEnded: boolean;
}

const COLORS = {
  boardBg: '#16213e',
  boardGradientStart: '#1a2744',
  boardGradientEnd: '#0f1729',
  gridLine: '#3a4a6b',
  gridGlow: 'rgba(0, 217, 255, 0.1)',
  starPoint: '#4a5a7b',
  stoneBlack: '#1a1a1a',
  stoneBlackHighlight: '#4a4a4a',
  stoneWhite: '#e8e8e8',
  stoneWhiteShadow: 'rgba(0, 0, 0, 0.3)',
  accent: '#00d9ff',
  accentDim: 'rgba(0, 217, 255, 0.3)',
  accentGlow: 'rgba(0, 217, 255, 0.6)',
  danger: '#ff4757',
  dangerDim: 'rgba(255, 71, 87, 0.3)',
  dangerGlow: 'rgba(255, 71, 87, 0.6)',
  pending: 'rgba(0, 217, 255, 0.5)',
  lastMove: 'rgba(0, 217, 255, 0.8)',
  koBlocked: 'rgba(255, 71, 87, 0.4)',
  winningLine: '#2ed573',
  invalid: 'rgba(255, 71, 87, 0.15)',
  invalidMark: 'rgba(255, 71, 87, 0.4)',
};

// Star points for a 15x15 board (standard Go/Gomoku positions)
const STAR_POINTS: Position[] = [
  { row: 3, col: 3 }, { row: 3, col: 7 }, { row: 3, col: 11 },
  { row: 7, col: 3 }, { row: 7, col: 7 }, { row: 7, col: 11 },
  { row: 11, col: 3 }, { row: 11, col: 7 }, { row: 11, col: 11 },
];

export function setupCanvas(canvas: HTMLCanvasElement, cellSize: number, padding: number): CanvasRenderingContext2D {
  const dpr = window.devicePixelRatio || 1;
  const totalSize = cellSize * (BOARD_SIZE - 1) + padding * 2;
  
  canvas.width = totalSize * dpr;
  canvas.height = totalSize * dpr;
  canvas.style.width = `${totalSize}px`;
  canvas.style.height = `${totalSize}px`;
  
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  
  return ctx;
}

export function renderBoard(ctx: CanvasRenderingContext2D, options: BoardRenderOptions): void {
  const { cellSize, padding, board, pendingPlacements, pendingRift, lastPlacedPositions, 
          lastRiftedPosition, currentPlayer, hoverPosition, winningLine, winningLineBy,
          invalidPositions, gameEnded } = options;
  const totalSize = cellSize * (BOARD_SIZE - 1) + padding * 2;
  const opponent = currentPlayer === 'black' ? 'white' : 'black';

  // Clear and draw background
  ctx.clearRect(0, 0, totalSize, totalSize);
  
  // Board background with gradient
  const gradient = ctx.createLinearGradient(0, 0, totalSize, totalSize);
  gradient.addColorStop(0, COLORS.boardGradientStart);
  gradient.addColorStop(1, COLORS.boardGradientEnd);
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.roundRect(0, 0, totalSize, totalSize, 12);
  ctx.fill();

  // Draw grid lines
  ctx.strokeStyle = COLORS.gridLine;
  ctx.lineWidth = 1;

  for (let i = 0; i < BOARD_SIZE; i++) {
    const pos = padding + i * cellSize;
    
    // Horizontal line
    ctx.beginPath();
    ctx.moveTo(padding, pos);
    ctx.lineTo(padding + (BOARD_SIZE - 1) * cellSize, pos);
    ctx.stroke();

    // Vertical line
    ctx.beginPath();
    ctx.moveTo(pos, padding);
    ctx.lineTo(pos, padding + (BOARD_SIZE - 1) * cellSize);
    ctx.stroke();
  }

  // Draw star points
  ctx.fillStyle = COLORS.starPoint;
  for (const point of STAR_POINTS) {
    const x = padding + point.col * cellSize;
    const y = padding + point.row * cellSize;
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  // Draw invalid positions (opening constraints, colinearity violations, etc.)
  if (!gameEnded && invalidPositions.size > 0) {
    for (const key of invalidPositions) {
      const [row, col] = key.split(',').map(Number);
      if (board[row][col] === null) {
        const x = padding + col * cellSize;
        const y = padding + row * cellSize;
        ctx.fillStyle = COLORS.invalid;
        ctx.beginPath();
        ctx.arc(x, y, cellSize * 0.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // Draw Ko-blocked position
  if (lastRiftedPosition && !gameEnded) {
    const x = padding + lastRiftedPosition.col * cellSize;
    const y = padding + lastRiftedPosition.row * cellSize;
    ctx.fillStyle = COLORS.koBlocked;
    ctx.beginPath();
    ctx.arc(x, y, cellSize * 0.35, 0, Math.PI * 2);
    ctx.fill();
    
    // Draw X mark
    ctx.strokeStyle = COLORS.danger;
    ctx.lineWidth = 2;
    const offset = cellSize * 0.15;
    ctx.beginPath();
    ctx.moveTo(x - offset, y - offset);
    ctx.lineTo(x + offset, y + offset);
    ctx.moveTo(x + offset, y - offset);
    ctx.lineTo(x - offset, y + offset);
    ctx.stroke();
  }

  // Draw stones
  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      const stone = board[row][col];
      if (stone) {
        drawStone(ctx, padding + col * cellSize, padding + row * cellSize, stone, cellSize);
      }
    }
  }

  // Draw invalid targets on occupied intersections (e.g. forbidden rift targets in Long Pro)
  if (!gameEnded && invalidPositions.size > 0) {
    ctx.save();
    ctx.strokeStyle = COLORS.dangerDim;
    ctx.lineWidth = 2;
    ctx.setLineDash([]);

    for (const key of invalidPositions) {
      const [row, col] = key.split(',').map(Number);
      const cell = board[row]?.[col] ?? null;
      if (cell === null || cell === currentPlayer) continue;
      const x = padding + col * cellSize;
      const y = padding + row * cellSize;
      ctx.beginPath();
      ctx.arc(x, y, cellSize * 0.46, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  }

  // Draw cleared 5-in-a-row highlight:
  // - fill: semi-transparent ghost stone in the cleared stones' color
  // - outline: solid green ring
  if (winningLine && winningLine.length > 0) {
    const scoredBy = winningLineBy ?? currentPlayer;

    ctx.save();
    for (const pos of winningLine) {
      const x = padding + pos.col * cellSize;
      const y = padding + pos.row * cellSize;

      // Ghost stone (cleared stone color)
      drawStone(ctx, x, y, scoredBy, cellSize, 0.5);

      // Outer solid green ring
      ctx.strokeStyle = COLORS.winningLine;
      ctx.lineWidth = 3;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(x, y, cellSize * 0.48, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Draw last placed position indicators
  for (const pos of lastPlacedPositions) {
    const x = padding + pos.col * cellSize;
    const y = padding + pos.row * cellSize;
    ctx.strokeStyle = COLORS.lastMove;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, cellSize * 0.2, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Draw pending placements with glow effect
  for (const pos of pendingPlacements) {
    const x = padding + pos.col * cellSize;
    const y = padding + pos.row * cellSize;
    
    // Glow effect
    ctx.shadowColor = COLORS.accentGlow;
    ctx.shadowBlur = 15;
    drawStone(ctx, x, y, currentPlayer, cellSize, 0.85);
    ctx.shadowBlur = 0;
    
    // Accent ring
    ctx.strokeStyle = COLORS.accent;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, cellSize * 0.45, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Draw pending rift target with danger glow
  if (pendingRift) {
    const x = padding + pendingRift.col * cellSize;
    const y = padding + pendingRift.row * cellSize;
    
    // Danger glow
    ctx.shadowColor = COLORS.dangerGlow;
    ctx.shadowBlur = 20;
    ctx.strokeStyle = COLORS.danger;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(x, y, cellSize * 0.45, 0, Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;
    
    // X overlay
    ctx.strokeStyle = COLORS.danger;
    ctx.lineWidth = 3;
    const offset = cellSize * 0.25;
    ctx.beginPath();
    ctx.moveTo(x - offset, y - offset);
    ctx.lineTo(x + offset, y + offset);
    ctx.moveTo(x + offset, y - offset);
    ctx.lineTo(x - offset, y + offset);
    ctx.stroke();
  }

  // Draw hover indicators (only when game is active)
  if (hoverPosition && !gameEnded) {
    const hoverStone = board[hoverPosition.row]?.[hoverPosition.col];
    const isKoBlocked = positionsEqual(hoverPosition, lastRiftedPosition);
    const isPending = pendingPlacements.some(p => positionsEqual(p, hoverPosition));
    const isPendingRift = pendingRift && positionsEqual(hoverPosition, pendingRift);
    const isInvalid = invalidPositions.has(`${hoverPosition.row},${hoverPosition.col}`);
    
    const x = padding + hoverPosition.col * cellSize;
    const y = padding + hoverPosition.row * cellSize;

    if (hoverStone === opponent && !isPendingRift && !isInvalid) {
      // Hovering over opponent stone - show rift preview
      ctx.strokeStyle = COLORS.dangerDim;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(x, y, cellSize * 0.45, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (hoverStone === null && !isKoBlocked && !isPending && !isInvalid) {
      // Hovering over valid empty position - show ghost stone
      drawStone(ctx, x, y, currentPlayer, cellSize, 0.35);
      
      // Subtle accent outline
      ctx.strokeStyle = COLORS.accentDim;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, cellSize * 0.42, 0, Math.PI * 2);
      ctx.stroke();
    } else if (
      (isKoBlocked && hoverStone === null) ||
      (isInvalid && (hoverStone === null || hoverStone === opponent))
    ) {
      // Hovering over invalid position - show blocked indicator
      ctx.fillStyle = COLORS.invalidMark;
      ctx.beginPath();
      ctx.arc(x, y, cellSize * 0.3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawStone(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: 'black' | 'white',
  cellSize: number,
  alpha: number = 1
): void {
  const radius = cellSize * 0.42;
  
  ctx.save();
  ctx.globalAlpha = alpha;

  if (color === 'black') {
    // Black stone with glossy effect
    const gradient = ctx.createRadialGradient(
      x - radius * 0.3, y - radius * 0.3, 0,
      x, y, radius
    );
    gradient.addColorStop(0, COLORS.stoneBlackHighlight);
    gradient.addColorStop(0.5, COLORS.stoneBlack);
    gradient.addColorStop(1, '#000000');
    
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // White stone with shadow and highlight
    // Shadow
    ctx.fillStyle = COLORS.stoneWhiteShadow;
    ctx.beginPath();
    ctx.arc(x + 2, y + 2, radius, 0, Math.PI * 2);
    ctx.fill();

    // Stone
    const gradient = ctx.createRadialGradient(
      x - radius * 0.3, y - radius * 0.3, 0,
      x, y, radius
    );
    gradient.addColorStop(0, '#ffffff');
    gradient.addColorStop(0.7, COLORS.stoneWhite);
    gradient.addColorStop(1, '#c8c8c8');
    
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

export function getBoardPosition(
  event: MouseEvent,
  canvas: HTMLCanvasElement,
  cellSize: number,
  padding: number
): Position | null {
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;

  const col = Math.round((x - padding) / cellSize);
  const row = Math.round((y - padding) / cellSize);

  if (row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE) {
    return { row, col };
  }

  return null;
}

/**
 * Determines the cursor style based on hover position and game state
 */
export function getCursorStyle(
  hoverPosition: Position | null,
  board: Stone[][],
  currentPlayer: PlayerColor,
  lastRiftedPosition: Position | null,
  invalidPositions: Set<string>,
  gameEnded: boolean
): string {
  if (gameEnded || !hoverPosition) {
    return 'default';
  }

  const stone = board[hoverPosition.row]?.[hoverPosition.col];
  const opponent = currentPlayer === 'black' ? 'white' : 'black';
  const isKoBlocked = positionsEqual(hoverPosition, lastRiftedPosition);
  const isInvalid = invalidPositions.has(`${hoverPosition.row},${hoverPosition.col}`);

  if (stone === opponent) {
    return isInvalid ? 'not-allowed' : 'pointer'; // Can rift (unless opening-forbidden)
  } else if (stone === currentPlayer) {
    return 'not-allowed'; // Own stone
  } else if (isKoBlocked || isInvalid) {
    return 'not-allowed'; // Invalid position
  } else {
    return 'crosshair'; // Valid empty position
  }
}
