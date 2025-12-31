<script lang="ts">
  import { pendingPlacements, pendingRift, canConfirmMove, aiThinking, isAiTurn, winner, winningLine, gameStore } from '$lib/stores/gameStore';
  import { gameEngine } from '$lib/game/engine';

  function confirmMove() {
    gameEngine.confirmMove();
  }

  function cancelMove() {
    gameEngine.cancelMove();
  }

  function ordinal(n: number): string {
    const abs = Math.abs(n);
    const mod100 = abs % 100;
    if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
    switch (abs % 10) {
      case 1: return `${n}st`;
      case 2: return `${n}nd`;
      case 3: return `${n}rd`;
      default: return `${n}th`;
    }
  }

  let winnerName = $derived.by(() => ($winner === 'black' ? 'Black' : $winner === 'white' ? 'White' : ''));
  let loserName = $derived.by(() => ($winner === 'black' ? 'White' : $winner === 'white' ? 'Black' : ''));
  let isResignation = $derived.by(() => !($winningLine && $winningLine.length > 0));
  let turnNumber = $derived.by(() => {
    if (!$winner) return 0;
    const n = $gameStore.moveHistory.length;
    const isResign = !($winningLine && $winningLine.length > 0);
    return isResign ? n + 1 : n;
  });

  let isVsAi = $derived.by(() => $gameStore.gameMode === 'vs-ai' && $gameStore.aiColor !== null);
  let humanColor = $derived.by(() => {
    const ai = $gameStore.aiColor;
    if (!ai) return null;
    return ai === 'black' ? 'white' : 'black';
  });

  let resultDetail = $derived.by(() => {
    if (!$winner) return '';
    const actor = isResignation ? loserName : winnerName;
    const reason = isResignation ? 'resignation' : '5 in a row';
    return `${actor} ${reason} at ${ordinal(turnNumber)} turn`;
  });

  let resultText = $derived.by(() => {
    if (!$winner) return '';
    const base = resultDetail;
    if (!isVsAi || !humanColor) return base;
    const outcome = $winner === humanColor ? 'You won!' : 'You lost!';
    return `${outcome} ${base}`;
  });

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

{#if $winner}
  <div class="action-panel ended">
    <span class="mode-label result">{resultText}</span>
  </div>
{:else}
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
{/if}

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

  .action-panel.ended {
    justify-content: center;
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

  .mode-label.result {
    font-weight: 600;
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
