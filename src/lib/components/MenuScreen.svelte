<script lang="ts">
  import { gameStore } from '$lib/stores/gameStore';
  import { replayStore } from '$lib/stores/replayStore';
  import { parseGame, IntegrityError } from '$lib/game/saveFile';
  import type { OpeningPreset, PlayerColor, ScoreToWin } from '$lib/game/types';
  import { LONG_PRO_FORBIDDEN_MANHATTAN_RADIUS } from '$lib/game/openingRules';

  let showColorChoice = $state(false);
  let showSpectateChoice = $state(false);
  let fileInput: HTMLInputElement;
  let loadError = $state<string | null>(null);
  const scoreToWinOptions: ScoreToWin[] = [1, 3, 5, 0];
  let selectedScoreToWin = $state<ScoreToWin>(1);
  const openingOptions = [
    { label: 'Long Pro', value: 'long-pro' },
    { label: 'Standard', value: 'standard-empty' },
    { label: 'Legacy', value: 'legacy-black-center-white-first' },
  ] as const satisfies readonly { label: string; value: OpeningPreset }[];
  let selectedOpeningPreset = $state<OpeningPreset>('long-pro');
  const aiTimeOptions = [
    { label: '100ms', ms: 100 },
    { label: '1s', ms: 1000 },
    { label: '5s', ms: 5000 },
    { label: 'Ultra', ms: 0 },
  ] as const;
  let selectedVsAiTimeMs = $state<number>(5000);
  let selectedSpectateTimeMsBlack = $state<number>(5000);
  let selectedSpectateTimeMsWhite = $state<number>(5000);

  function startLocalGame() {
    gameStore.startGame('local', selectedScoreToWin, selectedOpeningPreset);
  }

  function startAiGame(playerColor: PlayerColor) {
    gameStore.startGame('vs-ai', playerColor, selectedScoreToWin, selectedVsAiTimeMs, selectedOpeningPreset);
  }

  function startSpectateGame() {
    gameStore.startGame('ai-vs-ai', selectedSpectateTimeMsBlack, selectedSpectateTimeMsWhite, selectedScoreToWin, selectedOpeningPreset);
  }

  function triggerFileSelect() {
    loadError = null;
    fileInput?.click();
  }

  async function handleFileSelect(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    try {
      const content = await file.text();
      const save = await parseGame(content);
      replayStore.enterReplayFromSave(save);
    } catch (err) {
      if (err instanceof IntegrityError) {
        loadError = `Integrity check failed: ${err.message}`;
      } else if (err instanceof Error) {
        loadError = `Failed to load replay: ${err.message}`;
      } else {
        loadError = 'Failed to load replay';
      }
    } finally {
      // Reset input so the same file can be selected again
      input.value = '';
    }
  }
</script>

<div class="menu-screen">
  <div class="menu-content">
    <h1 class="title">⬡⬡✕5</h1>

    <div class="match-settings">
      <div class="match-label">First to</div>
      <div class="preset-row score">
        {#each scoreToWinOptions as n}
          <button
            class="btn-preset"
            class:selected={selectedScoreToWin === n}
            onclick={() => (selectedScoreToWin = n)}
          >
            {n === 0 ? '∞' : n}
          </button>
        {/each}
      </div>
    </div>

    <div class="match-settings">
      <div class="match-label">Opening</div>
      <div class="preset-row opening">
        {#each openingOptions as opt}
          <button
            class="btn-preset"
            class:selected={selectedOpeningPreset === opt.value}
            onclick={() => (selectedOpeningPreset = opt.value)}
          >
            {opt.label}
          </button>
        {/each}
      </div>
    </div>

    <div class="menu-buttons">
      <button class="btn menu-btn" onclick={startLocalGame}>
        👥 Local
      </button>
      
      {#if !showColorChoice}
        <button class="btn menu-btn ai" onclick={() => { showSpectateChoice = false; showColorChoice = true; }}>
          🤖 vs AI
        </button>
      {:else}
        <div class="color-choice">
          <div class="spectate-label">Thinking time</div>
          <div class="preset-row">
            {#each aiTimeOptions as opt}
              <button
                class="btn-preset"
                class:selected={selectedVsAiTimeMs === opt.ms}
                onclick={() => (selectedVsAiTimeMs = opt.ms)}
              >
                {opt.label}
              </button>
            {/each}
          </div>

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

      {#if !showSpectateChoice}
        <button
          class="btn menu-btn spectate"
          onclick={() => {
            showColorChoice = false;
            showSpectateChoice = true;
          }}
        >
          👁 Spectate (AI vs AI)
        </button>
      {:else}
        <div class="spectate-choice">
          <div class="spectate-label">Thinking time</div>
          <div class="spectate-side">
            <div class="side-label">
              <span class="stone black small"></span>
              <span>Black</span>
            </div>
            <div class="preset-row">
              {#each aiTimeOptions as opt}
                <button
                  class="btn-preset"
                  class:selected={selectedSpectateTimeMsBlack === opt.ms}
                  onclick={() => (selectedSpectateTimeMsBlack = opt.ms)}
                >
                  {opt.label}
                </button>
              {/each}
            </div>
          </div>

          <div class="spectate-side">
            <div class="side-label">
              <span class="stone white small"></span>
              <span>White</span>
            </div>
            <div class="preset-row">
              {#each aiTimeOptions as opt}
                <button
                  class="btn-preset"
                  class:selected={selectedSpectateTimeMsWhite === opt.ms}
                  onclick={() => (selectedSpectateTimeMsWhite = opt.ms)}
                >
                  {opt.label}
                </button>
              {/each}
            </div>
          </div>
          <div class="spectate-actions">
            <button class="btn menu-btn spectate" onclick={startSpectateGame}>
              Start
            </button>
            <button class="btn-cancel" onclick={() => showSpectateChoice = false}>Cancel</button>
          </div>
        </div>
      {/if}

      <button class="btn menu-btn load" onclick={triggerFileSelect}>
        📂 Load Replay
      </button>
      <input
        type="file"
        accept=".grr"
        bind:this={fileInput}
        onchange={handleFileSelect}
        style="display: none;"
      />
      {#if loadError}
        <div class="load-error">{loadError}</div>
      {/if}
    </div>

    <div class="rules">
      <p><strong>⬡⬡</strong> Place 2 stones (colinearity rules apply)</p>
      <p><strong>✕</strong> Remove 1 enemy stone (Ko rule)</p>
      <p><strong>5</strong> in a row scores +1 and clears (not 6+)</p>
      {#if selectedOpeningPreset === 'long-pro'}
        <p><strong>Opening</strong> Long Pro: Black 1 at center; White 2; Black 2 outside center diamond (d&gt;{LONG_PRO_FORBIDDEN_MANHATTAN_RADIUS})</p>
      {:else if selectedOpeningPreset === 'legacy-black-center-white-first'}
        <p><strong>Opening</strong> Legacy: black is pre-placed at center; White moves first</p>
      {:else}
        <p><strong>Opening</strong> Standard: empty board; Black moves first</p>
      {/if}
      {#if selectedScoreToWin === 0}
        <p><strong>∞</strong> mode: play until no legal reinforce/score moves remain</p>
        <p>Higher score wins</p>
      {:else}
        <p><strong>{selectedScoreToWin}</strong> points wins</p>
      {/if}
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

  .match-settings {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 14px;
  }

  .match-label {
    font-size: 12px;
    color: var(--text-secondary);
    text-align: left;
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

  .btn.spectate {
    background: #16a085;
  }

  .btn.load {
    background: #2c3e50;
  }

  .load-error {
    padding: 8px 12px;
    background: rgba(255, 71, 87, 0.15);
    border: 1px solid var(--danger);
    border-radius: 6px;
    color: var(--danger);
    font-size: 12px;
    text-align: left;
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

  .spectate-choice {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px;
    background: var(--bg-secondary);
    border-radius: 8px;
    border: 1px solid var(--grid-line);
  }

  .spectate-label {
    font-size: 12px;
    color: var(--text-secondary);
    text-align: left;
  }

  .spectate-side {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .side-label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--text-primary);
    font-weight: 600;
  }

  .stone.small {
    width: 16px;
    height: 16px;
  }

  .preset-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    justify-content: center;
  }

  .preset-row.score {
    justify-content: flex-start;
  }

  .preset-row.opening {
    justify-content: flex-start;
  }

  .btn-preset {
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid var(--grid-line);
    background: var(--bg-primary);
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
    color: var(--text-primary);
    touch-action: manipulation;
    min-height: 36px;
  }

  .btn-preset:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  .btn-preset.selected {
    border-color: var(--accent);
    background: var(--accent-dim);
    color: var(--accent);
  }

  .spectate-actions {
    display: flex;
    flex-direction: column;
    gap: 6px;
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
