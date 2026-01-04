<script lang="ts">
  import { onMount } from 'svelte';
  import { gameStore, gamePhase } from '$lib/stores/gameStore';
  import { isReplaying } from '$lib/stores/replayStore';
  import { gameEngine, setFastMode } from '$lib/game/engine';
  import type { OpeningPreset, ScoreToWin } from '$lib/game/types';
  import MenuScreen from '$lib/components/MenuScreen.svelte';
  import GameBoard from '$lib/components/GameBoard.svelte';
  import ActionPanel from '$lib/components/ActionPanel.svelte';
  import GameStatus from '$lib/components/GameStatus.svelte';
  import ReplayPanel from '$lib/components/ReplayPanel.svelte';

  // Arena mode: embedded gameplay for the 16-iframe runner.
  // - hides header chrome
  // - disables scrolling
  // - enables fast mode (no animation delays)
  let arenaMode = false;
  if (typeof window !== 'undefined') {
    const p = new URLSearchParams(window.location.search);
    const a = p.get('arena');
    arenaMode = a === 'true' || a === '1';
  }

  function goToMenu() {
    gameEngine.terminateAi();
    gameStore.returnToMenu();
  }

  onMount(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionParam = params.get('session');
    const matchParam = params.get('match');
    const session = sessionParam ? Number.parseInt(sessionParam, 10) : null;
    const match = matchParam ? Number.parseInt(matchParam, 10) : null;
    const arenaParam = params.get('arena');
    const legacyFastParam = params.get('fast');
    arenaMode = arenaParam === 'true' || arenaParam === '1';
    const fastMode = arenaMode || legacyFastParam === '1' || legacyFastParam === 'true';

    // If embedded in an iframe (arena mode), forward game-end events to the parent.
    const isInIframe = window.parent !== window;
    const forwardTargetOrigin = window.location.origin;
    const forwardGameEnd = (event: Event) => {
      if (!isInIframe) return;
      const detail = (event as CustomEvent).detail as any;
      window.parent.postMessage(
        {
          type: 'grr:gameEnd',
          session: Number.isInteger(session) ? session : 0,
          match: Number.isInteger(match) ? match : -1,
          ...detail,
        },
        forwardTargetOrigin
      );
    };
    if (isInIframe) {
      window.addEventListener('grr:gameEnd', forwardGameEnd as EventListener);
    }

    // In arena mode, disable scrolling and hide scrollbars for the embedded gameplay page.
    // (CSS lives in app.css; we just toggle the class here.)
    document.documentElement.classList.toggle('arena-mode', arenaMode);
    document.body.classList.toggle('arena-mode', arenaMode);

    // Ensure animation delay mode is set deterministically from URL params.
    setFastMode(fastMode);
    
    // Check for auto-start spectate mode
    if (params.get('mode') === 'spectate') {
      const timeMs = parseInt(params.get('time') ?? '1000', 10) || 1000;
      const openingParam = params.get('opening') ?? 'long-pro';
      const scoreParam = parseInt(params.get('score') ?? '1', 10);
      
      // Validate opening preset
      const validOpenings: OpeningPreset[] = ['long-pro', 'standard-empty', 'legacy-black-center-white-first'];
      const opening: OpeningPreset = validOpenings.includes(openingParam as OpeningPreset) 
        ? (openingParam as OpeningPreset) 
        : 'long-pro';
      
      // Validate score to win
      const validScores: ScoreToWin[] = [0, 1, 3, 5];
      const scoreToWin: ScoreToWin = validScores.includes(scoreParam as ScoreToWin) 
        ? (scoreParam as ScoreToWin) 
        : 1;
      
      // Start spectate game with same time for both players
      gameStore.startGame('ai-vs-ai', timeMs, timeMs, scoreToWin, opening);
    }

    return () => {
      if (isInIframe) {
        window.removeEventListener('grr:gameEnd', forwardGameEnd as EventListener);
      }
      document.documentElement.classList.remove('arena-mode');
      document.body.classList.remove('arena-mode');
      setFastMode(false);
    };
  });
</script>

<svelte:head>
  <title>⬡⬡✕5</title>
  <meta name="description" content="A strategic variant of Gomoku" />
</svelte:head>

{#if $gamePhase === 'menu'}
  <MenuScreen />
{:else}
  <main class="game-container">
    {#if !arenaMode}
      <header class="game-header">
        <button class="btn-back" onclick={goToMenu}>←</button>
        <span class="title-text">⬡⬡✕5</span>
      </header>
    {/if}

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

  /* Arena embedded gameplay: force the wide (desktop) 3-column layout even in small iframes. */
  :global(html.arena-mode) .game-layout {
    flex-direction: row;
    flex-wrap: nowrap;
    justify-content: center;
    align-items: flex-start;
    gap: 10px;
  }

  :global(html.arena-mode) .top-bar {
    order: 0;
    width: 160px;
    max-width: none;
  }

  :global(html.arena-mode) .board-wrapper {
    order: 1;
  }

  :global(html.arena-mode) .bottom-bar {
    order: 2;
    width: 160px;
    max-width: none;
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
