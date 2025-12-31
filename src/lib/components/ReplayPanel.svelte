<script lang="ts">
  import { replayStore, replayIndex, replayMoveCount, isAutoPlaying } from '$lib/stores/replayStore';
  import { gameStore } from '$lib/stores/gameStore';
  import { downloadSaveFile } from '$lib/game/saveFile';

  function handleFirst() { replayStore.first(); }
  function handlePrev() { replayStore.prev(); }
  function handleNext() { replayStore.next(); }
  function handleLast() { replayStore.last(); }
  function handleAutoPlay() { replayStore.toggleAutoPlay(800); }

  function handleDownload() {
    const state = gameStore.getState();
    downloadSaveFile(state);
  }

  function handleExit() {
    replayStore.exitReplay();
  }

  let atStart = $derived($replayIndex === 0);
  let atEnd = $derived($replayIndex === $replayMoveCount);
</script>

<div class="replay-panel">
  <div class="nav-row">
    <button class="nav-btn" onclick={handleFirst} disabled={atStart}>⏮</button>
    <button class="nav-btn" onclick={handlePrev} disabled={atStart}>◀</button>
    <span class="counter">{$replayIndex}/{$replayMoveCount}</span>
    <button class="nav-btn" onclick={handleNext} disabled={atEnd}>▶</button>
    <button class="nav-btn" onclick={handleLast} disabled={atEnd}>⏭</button>
    <button class="nav-btn play" class:playing={$isAutoPlaying} onclick={handleAutoPlay}>
      {$isAutoPlaying ? '⏸' : '▶'}
    </button>
  </div>
  <div class="action-row">
    <button class="btn-sm" onclick={handleDownload}>↓ Save</button>
    <button class="btn-sm" onclick={handleExit}>Exit</button>
  </div>
</div>

<style>
  .replay-panel {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px 12px;
    background: var(--bg-secondary);
    border-radius: 8px;
    border: 1px solid var(--grid-line);
  }

  .nav-row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }

  .counter {
    font-size: 13px;
    font-weight: 500;
    color: var(--text-primary);
    min-width: 48px;
    text-align: center;
  }

  .nav-btn {
    width: 32px;
    height: 32px;
    border-radius: 6px;
    border: 1px solid var(--grid-line);
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: 12px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    touch-action: manipulation;
  }

  .nav-btn:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent);
  }

  .nav-btn:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  .nav-btn.play {
    background: var(--accent-dim);
    border-color: var(--accent);
    color: var(--accent);
  }

  .nav-btn.play.playing {
    background: var(--accent);
    color: var(--bg-primary);
  }

  .action-row {
    display: flex;
    gap: 6px;
    justify-content: center;
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
    touch-action: manipulation;
  }

  .btn-sm:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  .btn-sm.muted {
    color: var(--text-secondary);
  }
</style>
