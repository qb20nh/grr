<script lang="ts">
  import { gameStore, gamePhase } from '$lib/stores/gameStore';
  import { isReplaying } from '$lib/stores/replayStore';
  import { gameEngine } from '$lib/game/engine';
  import MenuScreen from '$lib/components/MenuScreen.svelte';
  import GameBoard from '$lib/components/GameBoard.svelte';
  import ActionPanel from '$lib/components/ActionPanel.svelte';
  import GameStatus from '$lib/components/GameStatus.svelte';
  import ReplayPanel from '$lib/components/ReplayPanel.svelte';

  function goToMenu() {
    gameEngine.terminateAi();
    gameStore.returnToMenu();
  }
</script>

<svelte:head>
  <title>⬡⬡✕5</title>
  <meta name="description" content="A strategic variant of Gomoku" />
</svelte:head>

{#if $gamePhase === 'menu'}
  <MenuScreen />
{:else}
  <main class="game-container">
    <header class="game-header">
      <button class="btn-back" onclick={goToMenu}>←</button>
      <span class="title-text">⬡⬡✕5</span>
    </header>

    <div class="game-layout">
      <div class="top-bar">
        <GameStatus />
      </div>

      <div class="board-wrapper">
        <GameBoard />
      </div>

      <div class="bottom-bar">
        {#if $isReplaying}
          <ReplayPanel />
        {:else}
          <ActionPanel />
        {/if}
      </div>
    </div>
  </main>
{/if}

<style>
  .game-container {
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
    padding: 8px;
    box-sizing: border-box;
  }

  .game-header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 6px;
  }

  .btn-back {
    width: 36px;
    height: 36px;
    background: transparent;
    border: 1px solid var(--grid-line);
    color: var(--text-secondary);
    border-radius: 6px;
    font-size: 16px;
    font-family: inherit;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    touch-action: manipulation;
  }

  .btn-back:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  .title-text {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-secondary);
    letter-spacing: 1px;
  }

  .game-layout {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
  }

  .top-bar,
  .bottom-bar {
    width: 100%;
    max-width: 520px;
  }

  .board-wrapper {
    display: flex;
    justify-content: center;
    align-items: center;
  }

  /* Use the 3-column layout only when there is enough horizontal room for BOTH side panels + board. */
  @media (min-width: 1024px) {
    .game-container {
      padding: 16px;
    }

    .game-layout {
      flex-direction: row;
      flex-wrap: nowrap;
      justify-content: center;
      align-items: flex-start;
      gap: 16px;
    }

    .top-bar {
      order: 0;
      width: 200px;
      max-width: none;
    }

    .board-wrapper {
      order: 1;
    }

    .bottom-bar {
      order: 2;
      width: 200px;
      max-width: none;
    }

    .title-text {
      font-size: 16px;
    }
  }
</style>
