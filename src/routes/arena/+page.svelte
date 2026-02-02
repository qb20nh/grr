<script lang="ts">
  import { onMount } from 'svelte';
  import { resolve } from '$app/paths';
  import { BOARD_SIZE } from '$lib/game/types';
  import type { AiVariant, Position } from '$lib/game/types';

  type Winner = 'black' | 'white' | null;

  interface GameEndMessage {
    type: 'grr:gameEnd';
    session: number;
    match: number;
    winner: Winner;
    moveCount: number;
    endReason: string;
    scores?: { black: number; white: number };
    openingPreset?: string;
    whiteFirstMovePositions?: Position[] | null;
  }

  interface MatchRecord {
    globalIndex: number;
    session: number;
    localIndex: number;
    winner: Winner;
    moveCount: number;
    endReason: string;
    whiteFirstMovePositions: Position[] | null;
    startedAt: number;
    endedAt: number;
  }

  interface SessionState {
    session: number;
    startedCount: number; // number of matches started by this session
    completedCount: number; // number of matches completed by this session
    currentGlobalIndex: number | null;
    currentLocalIndex: number | null;
    currentStartedAt: number | null;
    iframeSrc: string;
  }

  interface ArenaConfig {
    matches: number;
    sessions: number;
    cols: number;
    rows: number;
    timeMsBlack: number;
    timeMsWhite: number;
    variantBlack: AiVariant | null;
    variantWhite: AiVariant | null;
    swapHalf: boolean;
    opening: string;
    score: number;
    arena: boolean;
    scale: number;
  }

  const defaults: ArenaConfig = {
    matches: 256,
    sessions: 16,
    cols: 4,
    rows: 4,
    timeMsBlack: 1000,
    timeMsWhite: 1000,
    variantBlack: null,
    variantWhite: null,
    swapHalf: false,
    opening: 'long-pro',
    score: 1,
    arena: true,
    scale: 0.9,
  };

  let config = $state<ArenaConfig>({ ...defaults });
  let sessions = $state<SessionState[]>([]);
  let results = $state<MatchRecord[]>([]);
  let startedAt = $state<number>(Date.now());
  let finishedAt = $state<number | null>(null);
  let done = $state(false);
  let blackWins = $state(0);
  let whiteWins = $state(0);
  let draws = $state(0);
  let nowMs = $state<number>(Date.now());

  const completed = new Set<number>();
  let nextGlobalIndex = 0;

  function createZeroMatrix(size: number): number[][] {
    return Array.from({ length: size }, () => Array.from({ length: size }, () => 0));
  }

  function recomputeAggregatesFromResults(items: MatchRecord[]): {
    blackWins: number;
    whiteWins: number;
    draws: number;
    whiteFirstMoveWins: number[][];
    whiteFirstMoveLosses: number[][];
    completed: Set<number>;
  } {
    const winMat = createZeroMatrix(BOARD_SIZE);
    const lossMat = createZeroMatrix(BOARD_SIZE);
    const completed = new Set<number>();
    let blackWins = 0;
    let whiteWins = 0;
    let draws = 0;

    for (const r of items) {
      const idx = r.globalIndex;
      if (!Number.isInteger(idx) || idx < 0) continue;
      if (completed.has(idx)) continue;
      completed.add(idx);

      if (r.winner === 'black') blackWins += 1;
      else if (r.winner === 'white') whiteWins += 1;
      else draws += 1;

      if (!r.whiteFirstMovePositions) continue;
      if (r.winner !== 'white' && r.winner !== 'black') continue;
      const target = r.winner === 'white' ? winMat : lossMat;
      for (const p of r.whiteFirstMovePositions) {
        if (!p) continue;
        const row = Math.floor(p.row);
        const col = Math.floor(p.col);
        if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) continue;
        target[row][col] += 1;
      }
    }

    return { blackWins, whiteWins, draws, whiteFirstMoveWins: winMat, whiteFirstMoveLosses: lossMat, completed };
  }

  function buildCheckpoint(): unknown {
    return {
      version: 1,
      savedAt: Date.now(),
      config: { ...config },
      startedAt,
      results: results.map(r => ({
        ...r,
        whiteFirstMovePositions: r.whiteFirstMovePositions?.map(p => ({ row: p.row, col: p.col })) ?? null,
      })),
      openingStats: {
        whiteFirstMove: {
          wins: whiteFirstMoveWins.map(r => r.slice()),
          losses: whiteFirstMoveLosses.map(r => r.slice()),
        },
      },
    };
  }

  let whiteFirstMoveWins = $state<number[][]>(createZeroMatrix(BOARD_SIZE));
  let whiteFirstMoveLosses = $state<number[][]>(createZeroMatrix(BOARD_SIZE));

  interface HeatCell {
    row: number;
    col: number;
    wins: number;
    losses: number;
    net: number;
  }

  let whiteFirstMoveHeatmap = $derived.by((): { cells: HeatCell[]; maxAbs: number } => {
    const cells: HeatCell[] = [];
    let maxAbs = 0;

    for (let row = 0; row < BOARD_SIZE; row++) {
      const wRow = whiteFirstMoveWins[row] ?? [];
      const lRow = whiteFirstMoveLosses[row] ?? [];
      for (let col = 0; col < BOARD_SIZE; col++) {
        const wins = wRow[col] ?? 0;
        const losses = lRow[col] ?? 0;
        const net = wins - losses;
        const abs = Math.abs(net);
        if (abs > maxAbs) maxAbs = abs;
        cells.push({ row, col, wins, losses, net });
      }
    }

    return { cells, maxAbs };
  });

  function heatColor(net: number, maxAbs: number): string {
    if (net === 0 || maxAbs <= 0) return 'rgba(255,255,255,0.03)';
    const t = Math.min(1, Math.abs(net) / maxAbs);
    const a = 0.12 + 0.78 * t;
    return net > 0 ? `rgba(0, 200, 90, ${a})` : `rgba(220, 60, 60, ${a})`;
  }

  function sanitizeFilename(name: string): string {
    const trimmed = name.trim().replaceAll('\u0000', '');
    const replaced = trimmed.replaceAll(/[^a-zA-Z0-9._-]+/g, '_');
    const collapsed = replaced.replaceAll(/_+/g, '_').replace(/^_+/, '').replace(/_+$/, '');
    const base = collapsed.length > 0 ? collapsed : 'grr_matches';
    return base.endsWith('.json') ? base : `${base}.json`;
  }

  function isoStampForFilename(d: Date): string {
    return d.toISOString().replaceAll(':', '-');
  }

  function formatEta(ms: number): string {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const s = totalSeconds % 60;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const m = totalMinutes % 60;
    const h = Math.floor(totalMinutes / 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  const etaText = $derived.by((): string => {
    if (done) return 'ETA: 0:00';
    const total = Math.max(0, Math.floor(config.matches));
    const completedCount = results.length;
    const remaining = total - completedCount;
    if (remaining <= 0) return 'ETA: 0:00';
    const elapsedMs = nowMs - startedAt;
    if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 'ETA: --';
    // Avoid noisy early ETAs.
    if (completedCount < Math.min(8, total)) return 'ETA: --';
    const rate = completedCount / elapsedMs; // matches per ms
    if (!Number.isFinite(rate) || rate <= 0) return 'ETA: --';
    const etaMs = remaining / rate;
    if (!Number.isFinite(etaMs) || etaMs <= 0) return 'ETA: --';
    return `ETA: ${formatEta(etaMs)}`;
  });

  function buildSuggestedFilename(): string {
    const stamp = isoStampForFilename(new Date(finishedAt ?? Date.now()));
    const variantTag =
      config.variantBlack || config.variantWhite
        ? `vb${config.variantBlack ?? 'time'}_vw${config.variantWhite ?? 'time'}`
        : null;
    const timeTag =
      config.swapHalf || config.timeMsBlack !== config.timeMsWhite
        ? `tb${config.timeMsBlack}_tw${config.timeMsWhite}${config.swapHalf ? '_swapHalf' : ''}`
        : `t${config.timeMsBlack}`;
    const tag = variantTag ? `${variantTag}_${timeTag}` : timeTag;
    return sanitizeFilename(
      `grr_${config.opening}_${config.matches}m_${config.sessions}s_${config.cols}x${config.rows}_score${config.score}_${tag}_${stamp}.json`
    );
  }

  function clampInt(n: number, min: number, max: number): number {
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, Math.floor(n)));
  }

  function clampFloat(n: number, min: number, max: number): number {
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
  }

  function parseConfigFromLocation(): ArenaConfig {
    const p = new URLSearchParams(window.location.search);

    const normalizeVariant = (value: string | null): AiVariant | null => {
      if (value === 'baseline5s' || value === 'singleUltra60s' || value === 'ultraV2_60s') return value;
      return null;
    };

    const matches = clampInt(Number(p.get('matches') ?? defaults.matches), 1, 1_000_000);
    const sessions = clampInt(Number(p.get('sessions') ?? defaults.sessions), 1, 256);
    const cols = clampInt(Number(p.get('cols') ?? defaults.cols), 1, 16);
    const rows = clampInt(Number(p.get('rows') ?? defaults.rows), 1, 64);
    const timeBase = clampInt(Number(p.get('time') ?? defaults.timeMsBlack), 0, 60_000);
    const timeMsBlack = clampInt(Number(p.get('timeBlack') ?? timeBase), 0, 60_000);
    const timeMsWhite = clampInt(Number(p.get('timeWhite') ?? timeBase), 0, 60_000);
    const variantBlack = normalizeVariant(p.get('variantBlack'));
    const variantWhite = normalizeVariant(p.get('variantWhite'));
    const swapHalfRaw = p.get('swapHalf');
    const swapHalf = swapHalfRaw === '1' || swapHalfRaw === 'true';
    const opening = String(p.get('opening') ?? defaults.opening);
    const score = clampInt(Number(p.get('score') ?? defaults.score), 0, 99);
    const arenaRaw = p.get('arena');
    const arena =
      arenaRaw != null
        ? arenaRaw === 'true' || arenaRaw === '1'
        : (p.get('fast') ?? (defaults.arena ? '1' : '0')) === '1';
    const scale = clampFloat(Number(p.get('scale') ?? defaults.scale), 0.25, 1);

    // Ensure the grid has enough cells for sessions.
    let finalCols = cols;
    let finalRows = rows;
    if (finalCols * finalRows < sessions) {
      finalRows = Math.ceil(sessions / finalCols);
    }

    return {
      matches,
      sessions,
      cols: finalCols,
      rows: finalRows,
      timeMsBlack,
      timeMsWhite,
      variantBlack,
      variantWhite,
      swapHalf,
      opening,
      score,
      arena,
      scale,
    };
  }

  function getSidesForMatch(globalIndex: number): {
    blackMs: number;
    whiteMs: number;
    variantBlack: AiVariant | null;
    variantWhite: AiVariant | null;
  } {
    let blackMs = config.timeMsBlack;
    let whiteMs = config.timeMsWhite;
    let variantBlack = config.variantBlack;
    let variantWhite = config.variantWhite;
    if (config.swapHalf) {
      const half = Math.floor(config.matches / 2);
      if (globalIndex >= half) {
        const tmp = blackMs;
        blackMs = whiteMs;
        whiteMs = tmp;
        const tmpVar = variantBlack;
        variantBlack = variantWhite;
        variantWhite = tmpVar;
      }
    }
    return { blackMs, whiteMs, variantBlack, variantWhite };
  }

  function buildGameUrl(sessionId: number, globalIndex: number): string {
    const { blackMs, whiteMs, variantBlack, variantWhite } = getSidesForMatch(globalIndex);
    const params = new URLSearchParams({
      mode: 'spectate',
      timeBlack: String(blackMs),
      timeWhite: String(whiteMs),
      opening: config.opening,
      score: String(config.score),
      arena: config.arena ? 'true' : 'false',
      session: String(sessionId),
      match: String(globalIndex),
    });
    if (variantBlack) params.set('variantBlack', variantBlack);
    if (variantWhite) params.set('variantWhite', variantWhite);
    // Respect SvelteKit base path (e.g. `/grr` in preview builds) without using the deprecated `base`.
    const root = resolve('/');
    const withSlash = root.endsWith('/') ? root : `${root}/`;
    return `${withSlash}?${params.toString()}`;
  }

  function startNextMatchForSession(s: SessionState): void {
    if (done) return;
    // Skip already-completed match indices (resume support).
    while (nextGlobalIndex < config.matches && completed.has(nextGlobalIndex)) {
      nextGlobalIndex += 1;
    }
    if (nextGlobalIndex >= config.matches) {
      s.currentGlobalIndex = null;
      s.currentLocalIndex = null;
      s.currentStartedAt = null;
      s.iframeSrc = 'about:blank';
      return;
    }

    const globalIndex = nextGlobalIndex;
    nextGlobalIndex += 1;
    s.currentGlobalIndex = globalIndex;
    s.currentLocalIndex = s.startedCount;
    s.startedCount += 1;
    s.currentStartedAt = Date.now();
    s.iframeSrc = buildGameUrl(s.session, globalIndex);
  }

  function buildPayload(): unknown {
    const thinkingTimeMs =
      !config.swapHalf && config.timeMsBlack === config.timeMsWhite ? config.timeMsBlack : null;
    return {
      config: {
        opening: config.opening,
        thinkingTimeMs,
        thinkingTimeMsBlack: config.timeMsBlack,
        thinkingTimeMsWhite: config.timeMsWhite,
        variantBlack: config.variantBlack,
        variantWhite: config.variantWhite,
        swapHalf: config.swapHalf,
        totalMatches: config.matches,
        sessions: config.sessions,
        cols: config.cols,
        rows: config.rows,
        scoreToWin: config.score,
        arena: config.arena,
        scale: config.scale,
      },
      summary: {
        blackWins,
        whiteWins,
        draws,
        timeStarted: startedAt,
        timeEnded: finishedAt ?? Date.now(),
        elapsedMs: (finishedAt ?? Date.now()) - startedAt,
      },
      openingStats: {
        whiteFirstMove: {
          wins: whiteFirstMoveWins.map(r => r.slice()),
          losses: whiteFirstMoveLosses.map(r => r.slice()),
        },
      },
      perMatch: results.slice().sort((a, b) => a.globalIndex - b.globalIndex),
    };
  }

  function finalize(): void {
    if (done) return;
    done = true;
    finishedAt = Date.now();
    document.title = `Arena done (${results.length}/${config.matches})`;
    const payload = buildPayload();
    const filename = buildSuggestedFilename();

    window.__grrArenaReport = payload;
    window.__grrArenaSuggestedFilename = filename;
    window.__grrArenaDone = true;

    // Best-effort persistence so a completed run can be recovered even if the window is closed.
    try {
      localStorage.setItem('grr_arena_last_filename', filename);
      localStorage.setItem('grr_arena_last_report', JSON.stringify(payload));
      localStorage.setItem('grr_arena_last_savedAt', String(Date.now()));
    } catch {
      // ignore storage quota / private mode
    }

    // If the runner exposed a save hook, call it (more reliable than download UX).
    try {
      const sink = (window as any).__grrArenaReportReady as unknown;
      if (typeof sink === 'function') {
        // Don't await; keep UI responsive.
        void Promise.resolve(sink(payload, filename));
      }
    } catch {
      // ignore
    }

    console.log('[arena] done', {
      file: filename,
      matches: results.length,
      blackWins,
      whiteWins,
      draws,
      elapsedMs: (finishedAt ?? Date.now()) - startedAt,
    });
  }

  function downloadJson(payload: unknown, filename: string): void {
    const blob = new Blob([JSON.stringify(payload, null, 2) + '\n'], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = sanitizeFilename(filename);
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5_000);
  }

  function handleDownloadClick(): void {
    downloadJson(buildPayload(), buildSuggestedFilename());
  }

  function onGameEnd(msg: GameEndMessage): void {
    if (done) return;
    if (!Number.isInteger(msg.session) || msg.session < 0) return;
    if (!Number.isInteger(msg.match) || msg.match < 0) return;
    if (completed.has(msg.match)) return;
    completed.add(msg.match);

    const s = sessions[msg.session];
    if (!s) return;
    if (s.currentGlobalIndex === null || s.currentGlobalIndex !== msg.match) return;

    const endedAt = Date.now();
    const started = s.currentStartedAt ?? endedAt;
    const localIndex = s.currentLocalIndex ?? s.completedCount;
    const whiteFirst =
      Array.isArray(msg.whiteFirstMovePositions) ? msg.whiteFirstMovePositions.map(p => ({ row: p.row, col: p.col })) : null;

    // Aggregate White's first reinforce positions by outcome.
    const shouldAccumulate = whiteFirst && (msg.winner === 'white' || msg.winner === 'black');
    if (shouldAccumulate) {
      const target = msg.winner === 'white' ? whiteFirstMoveWins : whiteFirstMoveLosses;
      for (const p of whiteFirst) {
        if (!p) continue;
        const row = Math.floor(p.row);
        const col = Math.floor(p.col);
        if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) continue;
        target[row][col] += 1;
      }
    }

    results.push({
      globalIndex: msg.match,
      session: msg.session,
      localIndex,
      winner: msg.winner ?? null,
      moveCount: Number.isFinite(msg.moveCount) ? Math.max(0, Math.floor(msg.moveCount)) : 0,
      endReason: String(msg.endReason ?? 'unknown'),
      whiteFirstMovePositions: whiteFirst,
      startedAt: started,
      endedAt,
    });

    s.completedCount += 1;

    if (msg.winner === 'black') blackWins += 1;
    else if (msg.winner === 'white') whiteWins += 1;
    else draws += 1;

    document.title = `Arena ${results.length}/${config.matches} (B${blackWins} W${whiteWins} D${draws})`;

    // Start the next match for this session (if any).
    startNextMatchForSession(s);

    if (results.length >= config.matches) {
      finalize();
    }
  }

  onMount(() => {
    window.__grrArenaDone = false;
    window.__grrArenaReport = undefined;
    window.__grrArenaSuggestedFilename = undefined;
    window.__grrArenaGetCheckpoint = () => buildCheckpoint();

    config = parseConfigFromLocation();
    const restore = window.__grrArenaRestore;
    window.__grrArenaRestore = undefined;

    // Reset mutable non-reactive collections.
    completed.clear();
    done = false;
    finishedAt = null;

    if (restore && typeof restore === 'object') {
      try {
        const r = restore as any;
        const restoredResults = Array.isArray(r.results) ? (r.results as MatchRecord[]) : [];
        results = restoredResults;
        startedAt = typeof r.startedAt === 'number' && Number.isFinite(r.startedAt) ? r.startedAt : Date.now();

        const agg = recomputeAggregatesFromResults(results);
        blackWins = agg.blackWins;
        whiteWins = agg.whiteWins;
        draws = agg.draws;
        whiteFirstMoveWins = agg.whiteFirstMoveWins;
        whiteFirstMoveLosses = agg.whiteFirstMoveLosses;
        for (const idx of agg.completed) completed.add(idx);

        document.title = `Arena ${results.length}/${config.matches} (B${blackWins} W${whiteWins} D${draws})`;
      } catch {
        // Fall back to a fresh run.
        results = [];
        startedAt = Date.now();
        blackWins = 0;
        whiteWins = 0;
        draws = 0;
        whiteFirstMoveWins = createZeroMatrix(BOARD_SIZE);
        whiteFirstMoveLosses = createZeroMatrix(BOARD_SIZE);
        document.title = `Arena 0/${config.matches}`;
      }
    } else {
      results = [];
      startedAt = Date.now();
      blackWins = 0;
      whiteWins = 0;
      draws = 0;
      whiteFirstMoveWins = createZeroMatrix(BOARD_SIZE);
      whiteFirstMoveLosses = createZeroMatrix(BOARD_SIZE);
      document.title = `Arena 0/${config.matches}`;
    }

    nextGlobalIndex = 0;
    sessions = Array.from({ length: config.sessions }, (_, sessionId) => ({
      session: sessionId,
      startedCount: 0,
      completedCount: 0,
      currentGlobalIndex: null,
      currentLocalIndex: null,
      currentStartedAt: null,
      iframeSrc: 'about:blank',
    }));

    // Start first match in every session.
    for (const s of sessions) {
      startNextMatchForSession(s);
    }

    const handler = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as any;
      if (!data || data.type !== 'grr:gameEnd') return;
      onGameEnd(data as GameEndMessage);
    };
    window.addEventListener('message', handler);

    const interval = window.setInterval(() => {
      // Update once per second for ETA.
      nowMs = Date.now();
    }, 1000);

    return () => {
      window.removeEventListener('message', handler);
      clearInterval(interval);
    };
  });
</script>

<div
  class="arena"
  style={`--cols:${config.cols}; --rows:${config.rows}; --scale:${config.scale}; --invScale:${1 / config.scale};`}
>
  <div class="topbar">
    <div class="title">Arena</div>
    <div class="stats">
      <span>{results.length}/{config.matches}</span>
      <span> B:{blackWins}</span>
      <span> W:{whiteWins}</span>
      <span> D:{draws}</span>
      <span class="mono eta">{etaText}</span>
      {#if done}
        <span class="done">done</span>
      {/if}
    </div>
    <div class="actions">
      <button class="btn" onclick={handleDownloadClick} disabled={results.length === 0}>
        Download JSON
      </button>
    </div>
  </div>

  {#if done}
    <div class="heatmap-panel">
      <div class="heatmap-title">White first move (net wins/losses)</div>
      <div class="heatmap-grid" style={`--heatSize:${BOARD_SIZE};`}>
        {#each whiteFirstMoveHeatmap.cells as cell (cell.row * BOARD_SIZE + cell.col)}
          <div
            class="heat-cell"
            style={`background:${heatColor(cell.net, whiteFirstMoveHeatmap.maxAbs)};`}
            title={`(${cell.row},${cell.col})  wins:${cell.wins}  losses:${cell.losses}  net:${cell.net}`}
          ></div>
        {/each}
      </div>
      <div class="heatmap-legend">
        <span class="swatch win"></span> win
        <span class="swatch loss"></span> loss
      </div>
    </div>
  {/if}

  <div class="grid">
    {#each sessions as s (s.session)}
      <div class="cell">
        <div class="label">
          <span class="mono">S{s.session}</span>
          <span class="mono">{s.completedCount}</span>
        </div>
        <div class="frame">
          <div class="scale">
            <iframe
              src={s.iframeSrc}
              title={`session-${s.session}`}
              sandbox="allow-scripts allow-same-origin"
            ></iframe>
          </div>
        </div>
      </div>
    {/each}
  </div>
</div>

<style>
  .arena {
    width: 100vw;
    height: 100vh;
    display: flex;
    flex-direction: column;
    background: var(--bg-primary);
    gap: 6px;
    padding: 6px;
    box-sizing: border-box;
  }

  .topbar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px 8px;
    border: 1px solid var(--grid-line);
    border-radius: 8px;
    background: var(--bg-secondary);
  }

  .title {
    font-weight: 700;
    letter-spacing: 0.5px;
  }

  .stats {
    display: flex;
    gap: 10px;
    color: var(--text-secondary);
    font-size: 12px;
    flex: 1;
    flex-wrap: wrap;
  }

  .eta {
    color: var(--text-secondary);
  }

  .done {
    color: var(--success);
    font-weight: 700;
  }

  .actions {
    display: flex;
    gap: 8px;
  }

  .heatmap-panel {
    border: 1px solid var(--grid-line);
    border-radius: 8px;
    background: var(--bg-secondary);
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .heatmap-title {
    font-size: 12px;
    font-weight: 700;
    color: var(--text-primary);
  }

  .heatmap-grid {
    display: grid;
    grid-template-columns: repeat(var(--heatSize), 1fr);
    gap: 1px;
    width: min(320px, 100%);
  }

  .heat-cell {
    aspect-ratio: 1 / 1;
    border-radius: 2px;
    border: 1px solid rgba(255, 255, 255, 0.06);
    background: rgba(255, 255, 255, 0.03);
  }

  .heatmap-legend {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    color: var(--text-secondary);
  }

  .swatch {
    width: 10px;
    height: 10px;
    border-radius: 2px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    display: inline-block;
  }

  .swatch.win {
    background: rgba(0, 200, 90, 0.8);
  }

  .swatch.loss {
    background: rgba(220, 60, 60, 0.8);
  }

  .btn {
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid var(--grid-line);
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: 12px;
  }

  .btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .grid {
    flex: 1;
    display: grid;
    grid-template-columns: repeat(var(--cols), 1fr);
    grid-template-rows: repeat(var(--rows), 1fr);
    gap: 6px;
    min-height: 0;
  }

  .cell {
    position: relative;
    border-radius: 8px;
    border: 1px solid var(--grid-line);
    background: #000;
    overflow: hidden;
  }

  .label {
    position: absolute;
    top: 6px;
    left: 6px;
    z-index: 2;
    display: flex;
    gap: 8px;
    padding: 4px 6px;
    border-radius: 6px;
    background: rgba(0, 0, 0, 0.6);
    border: 1px solid rgba(255, 255, 255, 0.08);
    color: var(--text-primary);
    font-size: 11px;
  }

  .mono {
    font-family: inherit;
  }

  .frame {
    width: 100%;
    height: 100%;
    overflow: hidden;
  }

  .scale {
    width: calc(100% * var(--invScale));
    height: calc(100% * var(--invScale));
    transform: scale(var(--scale));
    transform-origin: top left;
  }

  iframe {
    width: 100%;
    height: 100%;
    border: 0;
    display: block;
    pointer-events: none; /* prevent accidental clicks while spectating */
    background: var(--bg-primary);
  }
</style>

