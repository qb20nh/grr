const statusEl = document.getElementById('status');
const tableEl = document.getElementById('runsTable');
const tbodyEl = tableEl.querySelector('tbody');
const detailsEl = document.getElementById('runDetails');
const refreshBtn = document.getElementById('refreshBtn');
const chartEl = document.getElementById('eloChart');
const ctx = chartEl.getContext('2d');

const presetSelect = document.getElementById('presetSelect');
const cyclesInput = document.getElementById('cyclesInput');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const jobStatusEl = document.getElementById('jobStatus');
const jobLogsEl = document.getElementById('jobLogs');

/** @typedef {{runId:string, startedAt?:string, endedAt?:string, summary:string, promoted?:boolean, elo?:number|null, ci_low?:number|null, ci_high?:number|null}} RunIndexEntry */

function setStatus(msg) {
  statusEl.textContent = msg;
}

function setJobStatus(msg) {
  jobStatusEl.textContent = msg;
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function fmtNum(x) {
  if (x == null || !Number.isFinite(x)) return '';
  return x.toFixed(1);
}

function fmtCi(lo, hi) {
  if (lo == null || hi == null) return '';
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return '';
  return `[${lo.toFixed(1)}, ${hi.toFixed(1)}]`;
}

function pill(text, kind) {
  const span = document.createElement('span');
  span.className = `pill pill--${kind}`;
  span.textContent = text;
  return span;
}

async function fetchJson(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  return await res.json();
}

async function postJson(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {})
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function clearTable() {
  tbodyEl.innerHTML = '';
}

function setDetails(obj) {
  detailsEl.textContent = JSON.stringify(obj, null, 2);
}

const MAX_LOG_LINES = 1500;

function appendJobLines(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return;
  const frag = document.createDocumentFragment();
  for (const x of lines) {
    frag.appendChild(document.createTextNode(String(x.line) + '\n'));
  }
  jobLogsEl.appendChild(frag);
  while (jobLogsEl.childNodes.length > MAX_LOG_LINES) {
    jobLogsEl.removeChild(jobLogsEl.firstChild);
  }
  jobLogsEl.scrollTop = jobLogsEl.scrollHeight;
}

function drawChart(runs) {
  const w = chartEl.width;
  const h = chartEl.height;
  ctx.clearRect(0, 0, w, h);

  // axes padding
  const padL = 50;
  const padR = 14;
  const padT = 14;
  const padB = 28;

  const pts = runs
    .map((r, i) => ({ i, elo: r.elo, lo: r.ci_low, hi: r.ci_high }))
    .filter(p => typeof p.elo === 'number' && Number.isFinite(p.elo));

  // Background
  ctx.fillStyle = '#0f1420';
  ctx.fillRect(0, 0, w, h);

  // Grid + axis range
  let minY = -100;
  let maxY = 100;
  if (pts.length) {
    const ys = pts.flatMap(p => [p.elo, p.lo, p.hi].filter(v => typeof v === 'number' && Number.isFinite(v)));
    minY = Math.min(minY, ...ys) - 10;
    maxY = Math.max(maxY, ...ys) + 10;
  }
  if (minY === maxY) {
    minY -= 1;
    maxY += 1;
  }

  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const xOf = (i) => padL + (pts.length <= 1 ? plotW / 2 : (i / (pts.length - 1)) * plotW);
  const yOf = (y) => padT + (1 - (y - minY) / (maxY - minY)) * plotH;

  // Grid lines
  ctx.strokeStyle = 'rgba(154,164,178,0.15)';
  ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    const y = padT + (g / 4) * plotH;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
  }

  // Zero line
  const y0 = yOf(0);
  ctx.strokeStyle = 'rgba(79,156,240,0.30)';
  ctx.beginPath();
  ctx.moveTo(padL, y0);
  ctx.lineTo(w - padR, y0);
  ctx.stroke();

  // CI band
  ctx.strokeStyle = 'rgba(154,164,178,0.35)';
  ctx.lineWidth = 2;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (!Number.isFinite(p.lo) || !Number.isFinite(p.hi)) continue;
    const x = xOf(i);
    ctx.beginPath();
    ctx.moveTo(x, yOf(p.lo));
    ctx.lineTo(x, yOf(p.hi));
    ctx.stroke();
  }

  // Elo line
  ctx.strokeStyle = '#4f9cf0';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const x = xOf(i);
    const y = yOf(p.elo);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Points
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const x = xOf(i);
    const y = yOf(p.elo);
    ctx.fillStyle = '#4f9cf0';
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // Y labels
  ctx.fillStyle = 'rgba(230,237,243,0.8)';
  ctx.font = '12px ui-sans-serif, system-ui';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let g = 0; g <= 4; g++) {
    const y = padT + (g / 4) * plotH;
    const val = maxY - (g / 4) * (maxY - minY);
    ctx.fillText(val.toFixed(0), padL - 8, y);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText('run index', padL + plotW / 2, h - padB + 8);
}

async function loadRuns() {
  setStatus('Loading runs...');
  let idx;
  try {
    idx = await fetchJson('/runs/index.json');
  } catch {
    idx = { runs: [] };
  }
  const runs = Array.isArray(idx.runs) ? idx.runs : [];
  // Sort by startedAt if present, else by runId.
  runs.sort((a, b) => {
    const da = a.startedAt ? Date.parse(a.startedAt) : Number.NaN;
    const db = b.startedAt ? Date.parse(b.startedAt) : Number.NaN;
    if (Number.isFinite(da) && Number.isFinite(db)) return da - db;
    return String(a.runId).localeCompare(String(b.runId));
  });

  clearTable();
  for (const r of runs) {
    const tr = document.createElement('tr');
    tr.dataset.runId = r.runId;

    const tdRun = document.createElement('td');
    tdRun.textContent = r.runId;

    const tdStart = document.createElement('td');
    tdStart.textContent = fmtDate(r.startedAt);

    const tdProm = document.createElement('td');
    if (r.promoted === true) tdProm.appendChild(pill('yes', 'good'));
    else if (r.promoted === false) tdProm.appendChild(pill('no', 'bad'));
    else tdProm.appendChild(pill('-', 'muted'));

    const tdElo = document.createElement('td');
    tdElo.textContent = fmtNum(r.elo);

    const tdCi = document.createElement('td');
    tdCi.textContent = fmtCi(r.ci_low, r.ci_high);

    tr.appendChild(tdRun);
    tr.appendChild(tdStart);
    tr.appendChild(tdProm);
    tr.appendChild(tdElo);
    tr.appendChild(tdCi);

    tr.addEventListener('click', async () => {
      const prev = tbodyEl.querySelector('tr.selected');
      if (prev) prev.classList.remove('selected');
      tr.classList.add('selected');

      try {
        setStatus(`Loading ${r.runId}...`);
        const summary = await fetchJson(`/runs/${r.summary}`);
        setDetails(summary);
        setStatus(`Loaded ${r.runId}`);
      } catch (e) {
        setStatus(`Failed to load ${r.runId}: ${e}`);
      }
    });

    tbodyEl.appendChild(tr);
  }

  drawChart(runs);
  setStatus(`Loaded ${runs.length} runs`);
}

refreshBtn.addEventListener('click', () => {
  void loadRuns();
});

let logCursor = 0;
let lastRunning = false;
let lastRunsRefreshAt = 0;
const RUNS_REFRESH_MS_RUNNING = 5000;

async function loadPresets() {
  try {
    const presets = await fetchJson('/api/presets');
    presetSelect.innerHTML = '';
    for (const [key, val] of Object.entries(presets)) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = `${key} — ${val?.description ?? ''}`.trim();
      presetSelect.appendChild(opt);
    }
    if ([...presetSelect.options].some(o => o.value === 'balanced')) {
      presetSelect.value = 'balanced';
    }
  } catch (e) {
    presetSelect.innerHTML = '<option value="balanced">balanced</option>';
  }
}

async function pollJob() {
  try {
    const st = await fetchJson('/api/status');
    const running = Boolean(st.running);
    startBtn.disabled = running;
    stopBtn.disabled = !running;

    if (running) {
      setJobStatus(`Running (pid ${st.pid}) preset=${st.preset} cycles=${st.cycles}`);
    } else if (st.exitCode != null) {
      setJobStatus(`Finished (exit ${st.exitCode})`);
    } else {
      setJobStatus('Idle');
    }

    const log = await fetchJson(`/api/log?since=${logCursor}`);
    logCursor = Number.isFinite(log.next) ? log.next : logCursor;
    appendJobLines(log.lines);

    // While running, refresh runs periodically so the Elo chart updates per-cycle.
    if (running) {
      const now = Date.now();
      if (now - lastRunsRefreshAt > RUNS_REFRESH_MS_RUNNING) {
        lastRunsRefreshAt = now;
        void loadRuns();
      }
    }

    if (lastRunning && !running) {
      // Job finished; refresh runs list.
      void loadRuns();
    }
    lastRunning = running;
  } catch (e) {
    setJobStatus(`Error: ${e}`);
  }
}

startBtn.addEventListener('click', async () => {
  jobLogsEl.textContent = '';
  logCursor = 0;
  lastRunsRefreshAt = 0;
  const preset = presetSelect.value || 'balanced';
  const cycles = Math.max(1, Number.parseInt(cyclesInput.value || '1', 10));
  const res = await postJson('/api/start', { preset, cycles });
  if (!res.ok) {
    setJobStatus(`Start failed: ${res.data?.error ?? res.status}`);
    return;
  }
  setJobStatus('Starting...');
  void pollJob();
});

stopBtn.addEventListener('click', async () => {
  const res = await postJson('/api/stop', {});
  if (!res.ok) {
    setJobStatus(`Stop failed: ${res.data?.error ?? res.status}`);
    return;
  }
  setJobStatus('Stopping...');
});

void loadPresets();
void loadRuns();
setInterval(() => void pollJob(), 1000);
void pollJob();

