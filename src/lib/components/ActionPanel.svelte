<script lang="ts">
  import { pendingPlacements, pendingRift, canConfirmMove, aiThinking, isAiTurn } from '$lib/stores/gameStore';
  import { gameEngine } from '$lib/game/engine';

  function confirmMove() {
    gameEngine.confirmMove();
  }

  function cancelMove() {
    gameEngine.cancelMove();
  }

  let currentMode = $derived.by(() => {
    if ($pendingRift) return 'rift';
    if ($pendingPlacements.length > 0) return 'reinforce';
    return 'idle';
  });

  let idleText = $derived.by(() => {
    if ($aiThinking) return 'AI thinking...';
    if ($isAiTurn) return 'Opponent\'s turn';
    return 'Your turn';
  });

  let showConfirm = $derived($canConfirmMove);
  let showCancel = $derived(currentMode !== 'idle');
</script>

<div class="action-panel">
  <div class="mode-row">
    {#if currentMode === 'rift'}
      <span class="mode-icon rift">✕</span>
      <span class="mode-label">Rift</span>
    {:else if currentMode === 'reinforce'}
      <span class="mode-icon reinforce">⬡</span>
      <span class="mode-label">{$pendingPlacements.length}/2</span>
    {:else}
      <span class="mode-icon idle">·</span>
      <span class="mode-label muted">{idleText}</span>
    {/if}
  </div>

  <div class="btn-row">
    {#if showConfirm}
      <button class="btn confirm" onclick={confirmMove}>✓</button>
    {/if}
    {#if showCancel}
      <button class="btn cancel" onclick={cancelMove}>✕</button>
    {/if}
  </div>
</div>

<style>
  .action-panel {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 12px;
    background: var(--bg-secondary);
    border-radius: 8px;
    border: 1px solid var(--grid-line);
    min-height: 44px;
  }

  .mode-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .mode-icon {
    font-size: 16px;
    width: 20px;
    text-align: center;
  }

  .mode-icon.reinforce {
    color: var(--accent);
  }

  .mode-icon.rift {
    color: var(--danger);
  }

  .mode-icon.idle {
    color: var(--text-secondary);
  }

  .mode-label {
    font-size: 13px;
    font-weight: 500;
  }

  .mode-label.muted {
    color: var(--text-secondary);
  }

  .btn-row {
    display: flex;
    gap: 6px;
    min-width: 78px;
    justify-content: flex-end;
  }

  .btn {
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    border-radius: 6px;
    border: 1px solid var(--grid-line);
    background: transparent;
    color: var(--text-primary);
    cursor: pointer;
    font-family: inherit;
    touch-action: manipulation;
  }

  .btn.confirm {
    background: var(--success);
    border-color: var(--success);
    color: white;
  }

  .btn.confirm:hover {
    opacity: 0.9;
  }

  .btn.cancel:hover {
    border-color: var(--danger);
    color: var(--danger);
  }
</style>
