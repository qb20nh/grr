/**
 * AI Engine - Main Entry Point
 * Exports all public functions for the Gomoku Rift AI
 */

// Types
export * from './types';

// Constants
export { CONFIG, BOARD_SIZE, BOARD_CELLS } from './constants';

// Board operations
export {
  createBoard,
  boardFrom2D,
  boardTo2D,
  cloneBoard,
  getCell,
  getCellAt,
  isEmpty,
  isValidPlacement,
  checkColinearityConstraint,
  validateReinforce,
  validateRift,
  makeMove,
  unmakeMove,
  checkWinAt,
  hasWon,
  getTotalStones,
  isBoardEmpty,
  getStonePositions,
  getEmptyPositions,
} from './board';

// Utilities
export {
  toIndex,
  toPosition,
  inBounds,
  getOpponent,
  manhattanDistance,
  movesEqual,
  moveToKey,
  createReinforceMove,
  createSingleWinMove,
  createRiftMove,
  moveToLegacy,
  legacyToMove,
  isSingleWinMove,
} from './utils';

// Pattern detection
export {
  scanLine,
  classifyLine,
  countPatterns,
  getPatternsAtPosition,
  wouldCreatePattern,
  countThreatsCreated,
  getBestPattern,
  hasImmediateWin,
} from './patterns';

// Threat analysis
export {
  getThreatLevel,
  hasCriticalThreat,
  hasWinningThreat,
  canWinNextMove,
  detectForks,
  countForks,
  findBlockingPositions,
  findWinningPositions,
  analyzeThreatSituation,
  riftBreaksThreat,
  evaluateRiftTarget,
} from './threats';

// Synergy scoring
export {
  usesShieldException,
  extendsSameLine,
  blocksOpponentThreat,
  createsWinningThreat,
  evaluatePairSynergy,
  evaluateSinglePosition,
  evaluateReinforceMove,
} from './synergy';

// Evaluation
export {
  evaluate,
  quickEvaluate,
  evaluateAfterMove,
  isQuietPosition,
} from './evaluate';

// Move generation
export {
  getCandidatePositions,
  generateReinforceMoves,
  generateRiftMoves,
  generateAllMoves,
  generateTacticalMoves,
  generateBlockingMoves,
} from './moveGen';

// Move ordering
export {
  updateKillerMoves,
  updateHistory,
  clearMoveOrdering,
  orderMoves,
  PVTable,
} from './moveOrder';

// Search
export {
  findBestMove,
  iterativeDeepening,
  createSearchSession,
  getSearchStats,
  abortSearch,
} from './search';

// Threat space search (tactical prover)
export { threatSpaceSearch } from './tss';

// Time management
export {
  getGamePhase,
  calculateTimeForMove,
  getEmergencyTime,
  getQuickMoveTime,
  createTimeState,
  shouldStopSearch,
} from './timeManager';

// Transposition table
export {
  TranspositionTable,
  getTranspositionTable,
  clearTranspositionTable,
} from './transposition';

// Zobrist hashing
export {
  updateHash,
  computeFullHash,
} from './zobrist';

