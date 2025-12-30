<script lang="ts">
  import { gameStore } from '$lib/stores/gameStore';
  import type { PlayerColor } from '$lib/game/types';

  let showColorChoice = $state(false);

  function startLocalGame() {
    gameStore.startGame('local');
  }

  function startAiGame(playerColor: PlayerColor) {
    gameStore.startGame('vs-ai', playerColor);
  }
</script>

<div class="menu-screen">
  <div class="menu-content">
    <h1 class="title">⬡⬡✕5</h1>

    <div class="menu-buttons">
      <button class="btn menu-btn" onclick={startLocalGame}>
        👥 Local
      </button>
      
      {#if !showColorChoice}
        <button class="btn menu-btn ai" onclick={() => showColorChoice = true}>
          🤖 vs AI
        </button>
      {:else}
        <div class="color-choice">
          <div class="color-buttons">
            <button class="btn-color" onclick={() => startAiGame('black')}>
              <span class="stone black"></span>
              <span>1st</span>
            </button>
            <button class="btn-color" onclick={() => startAiGame('white')}>
              <span class="stone white"></span>
              <span>2nd</span>
            </button>
          </div>
          <button class="btn-cancel" onclick={() => showColorChoice = false}>Cancel</button>
        </div>
      {/if}
    </div>

    <div class="rules">
      <p><strong>⬡⬡</strong> Place 2 stones (colinearity rules apply)</p>
      <p><strong>✕</strong> Remove 1 enemy stone (Ko rule)</p>
      <p><strong>5</strong> in a row wins (not 6+)</p>
    </div>
  </div>
</div>

<style>
  .menu-screen {
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 100dvh;
    padding: 20px;
  }

  .menu-content {
    max-width: 320px;
    text-align: center;
  }

  .title {
    font-size: 28px;
    font-weight: 700;
    letter-spacing: 3px;
    color: var(--text-primary);
    margin-bottom: 24px;
  }

  .menu-buttons {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-bottom: 24px;
  }

  .btn {
    padding: 14px 24px;
    font-size: 15px;
    font-weight: 600;
    border-radius: 8px;
    border: none;
    cursor: pointer;
    font-family: inherit;
    background: var(--accent);
    color: var(--bg-primary);
    touch-action: manipulation;
    min-height: 48px;
  }

  .btn:hover {
    opacity: 0.9;
  }

  .btn.ai {
    background: #9b59b6;
  }

  .color-choice {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    background: var(--bg-secondary);
    border-radius: 8px;
    border: 1px solid var(--grid-line);
  }

  .color-buttons {
    display: flex;
    gap: 10px;
  }

  .btn-color {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 12px;
    border-radius: 8px;
    border: 1px solid var(--grid-line);
    background: var(--bg-primary);
    cursor: pointer;
    font-family: inherit;
    font-size: 13px;
    color: var(--text-primary);
    touch-action: manipulation;
    min-height: 48px;
  }

  .btn-color:hover {
    border-color: var(--accent);
  }

  .stone {
    width: 28px;
    height: 28px;
    border-radius: 50%;
  }

  .stone.black {
    background: radial-gradient(circle at 30% 30%, #4a4a4a, #1a1a1a 50%, #000);
    box-shadow: 0 1px 4px rgba(0,0,0,0.4);
  }

  .stone.white {
    background: radial-gradient(circle at 30% 30%, #fff, #e8e8e8 50%, #c8c8c8);
    box-shadow: 0 1px 4px rgba(0,0,0,0.2);
  }

  .btn-cancel {
    background: transparent;
    border: none;
    color: var(--text-secondary);
    font-size: 12px;
    cursor: pointer;
    padding: 6px;
    font-family: inherit;
  }

  .rules {
    text-align: left;
    font-size: 12px;
    color: var(--text-secondary);
    line-height: 1.6;
  }

  .rules p {
    margin: 4px 0;
  }

  .rules strong {
    color: var(--accent);
  }
</style>
