<script lang="ts">
  import { gameStore, currentPlayer, winner, isAiTurn, aiThinking, winningLine, gamePhase } from '$lib/stores/gameStore';
  import { replayStore, isReplaying } from '$lib/stores/replayStore';
  import { gameEngine } from '$lib/game/engine';

  let resignDialog: HTMLDialogElement;

  function showResignDialog() {
    resignDialog?.showModal();
  }

  function confirmResign() {
    resignDialog?.close();
    const state = gameStore.getState();
    const winnerColor = state.currentPlayer === 'black' ? 'white' : 'black';
    gameStore.setWinner(winnerColor);
  }

  function cancelResign() {
    resignDialog?.close();
  }

  function newGame() {
    gameEngine.terminateAi();
    gameStore.restartWithSameSettings();
  }

  function reviewGame() {
    replayStore.enterReplay();
  }
</script>

<div class="game-status">
  {#if $winner}
    <div class="status-row">
      <div class="stone" class:black={$winner === 'black'} class:white={$winner === 'white'}></div>
      {#if $isReplaying}
        <span class="status-text accent">Replay</span>
      {:else}
        <span class="status-text win">{$winner === 'black' ? 'Black' : 'White'} Wins</span>
      {/if}
    </div>
    {#if !$isReplaying}
      <div class="btn-row">
        <button class="btn-sm primary" onclick={newGame}>New</button>
        <button class="btn-sm" onclick={reviewGame}>Review</button>
      </div>
    {/if}
  {:else}
    <div class="status-row">
      <div class="stone" class:black={$currentPlayer === 'black'} class:white={$currentPlayer === 'white'}></div>
      <span class="status-text">{$currentPlayer === 'black' ? 'Black' : 'White'}</span>
      {#if $isAiTurn}
        <span class="badge">AI</span>
      {/if}
      {#if $aiThinking}
        <div class="spinner"></div>
      {/if}
    </div>
    {#if !$aiThinking && !$isAiTurn}
      <button class="btn-sm muted" onclick={showResignDialog}>Resign</button>
    {/if}
  {/if}
</div>

<dialog bind:this={resignDialog} class="confirm-dialog">
  <p>Resign this game?</p>
  <div class="dialog-buttons">
    <button class="btn-sm" onclick={cancelResign}>Cancel</button>
    <button class="btn-sm danger" onclick={confirmResign}>Resign</button>
  </div>
</dialog>

<style>
  .game-status {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 12px;
    background: var(--bg-secondary);
    border-radius: 8px;
    border: 1px solid var(--grid-line);
    min-height: 44px;
    flex-wrap: wrap;
  }

  .status-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .stone {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .stone.black {
    background: radial-gradient(circle at 30% 30%, #4a4a4a, #1a1a1a 50%, #000);
    box-shadow: 0 1px 4px rgba(0,0,0,0.4);
  }

  .stone.white {
    background: radial-gradient(circle at 30% 30%, #fff, #e8e8e8 50%, #c8c8c8);
    box-shadow: 0 1px 4px rgba(0,0,0,0.2);
  }

  .status-text {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
  }

  .status-text.win {
    color: var(--success);
  }

  .status-text.accent {
    color: var(--accent);
  }

  .badge {
    font-size: 9px;
    background: var(--accent-dim);
    color: var(--accent);
    padding: 2px 5px;
    border-radius: 3px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .spinner {
    width: 14px;
    height: 14px;
    border: 2px solid var(--accent-dim);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .btn-row {
    display: flex;
    gap: 6px;
  }

  .btn-sm {
    padding: 6px 12px;
    font-size: 12px;
    font-weight: 500;
    border-radius: 6px;
    border: 1px solid var(--grid-line);
    background: transparent;
    color: var(--text-primary);
    cursor: pointer;
    font-family: inherit;
    min-height: 32px;
    touch-action: manipulation;
  }

  .btn-sm:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  .btn-sm.primary {
    background: var(--accent);
    color: var(--bg-primary);
    border-color: var(--accent);
  }

  .btn-sm.primary:hover {
    background: var(--accent);
    opacity: 0.9;
  }

  .btn-sm.muted {
    color: var(--text-secondary);
    border-color: var(--grid-line);
  }

  .btn-sm.muted:hover {
    border-color: var(--danger);
    color: var(--danger);
  }

  .btn-sm.danger {
    background: var(--danger);
    color: white;
    border-color: var(--danger);
  }

  .btn-sm.danger:hover {
    opacity: 0.9;
  }

  .confirm-dialog {
    background: var(--bg-secondary);
    border: 1px solid var(--grid-line);
    border-radius: 12px;
    padding: 20px;
    color: var(--text-primary);
    max-width: 280px;
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    margin: 0;
  }

  .confirm-dialog::backdrop {
    background: rgba(0, 0, 0, 0.6);
  }

  .confirm-dialog p {
    margin: 0 0 16px 0;
    font-size: 14px;
    text-align: center;
  }

  .dialog-buttons {
    display: flex;
    gap: 8px;
    justify-content: center;
  }
</style>
