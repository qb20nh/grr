#!/usr/bin/env npx tsx
/**
 * Arena runner (single window, 16 iframes).
 *
 * Opens `/arena` which orchestrates multiple AI-vs-AI matches and downloads a JSON report.
 *
 * Typical usage:
 *   pnpm matches:256
 *
 * Use an already-running dev server instead:
 *   pnpm dev
 *   pnpm matches:256 -- --serve auto
 */

/// <reference path="./node-shim.d.ts" />

import { chromium } from 'playwright';
import type { BrowserContext, Page } from 'playwright';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

type AiVariant = 'baseline5s' | 'singleUltra60s' | 'ultraV2_60s';

interface Args {
  url: string | null;
  serve: 'auto' | 'preview';
  matches: number;
  sessions: number;
  cols: number;
  rows: number;
  timeMs: number;
  timeBlackMs: number | null;
  timeWhiteMs: number | null;
  variantBlack: AiVariant | null;
  variantWhite: AiVariant | null;
  swapHalf: boolean;
  opening: string;
  score: number;
  fast: boolean;
  scale: number;
  matrix: boolean;
  headless: boolean;
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function clampFloat(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    url: null,
    // Default to preview to avoid HMR reloads and window management issues.
    serve: 'preview',
    matches: 256,
    sessions: 16,
    cols: 4,
    rows: 4,
    timeMs: 1000,
    timeBlackMs: null,
    timeWhiteMs: null,
    variantBlack: null,
    variantWhite: null,
    swapHalf: false,
    opening: 'long-pro',
    score: 1,
    fast: true,
    scale: 0.5,
    matrix: false,
    headless: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v == null) throw new Error(`Missing value for ${a}`);
      i++;
      return v;
    };

    if (a === '--url') out.url = next();
    else if (a === '--serve') {
      const v = next();
      out.serve = v === 'preview' ? 'preview' : 'auto';
    } else if (a === '--matches') out.matches = Number.parseInt(next(), 10);
    else if (a === '--sessions') out.sessions = Number.parseInt(next(), 10);
    else if (a === '--windows') out.sessions = Number.parseInt(next(), 10); // backward-compat alias
    else if (a === '--cols') out.cols = Number.parseInt(next(), 10);
    else if (a === '--rows') out.rows = Number.parseInt(next(), 10);
    else if (a === '--time') out.timeMs = Number.parseInt(next(), 10);
    else if (a === '--time-black' || a === '--black-time') out.timeBlackMs = Number.parseInt(next(), 10);
    else if (a === '--time-white' || a === '--white-time') out.timeWhiteMs = Number.parseInt(next(), 10);
    else if (a === '--variant-black') out.variantBlack = next() as AiVariant;
    else if (a === '--variant-white') out.variantWhite = next() as AiVariant;
    else if (a === '--swap-half') out.swapHalf = true;
    else if (a === '--opening') out.opening = next();
    else if (a === '--score') out.score = Number.parseInt(next(), 10);
    else if (a === '--fast') out.fast = next() === '1';
    else if (a === '--scale') out.scale = Number.parseFloat(next());
    else if (a === '--matrix') out.matrix = true;
    else if (a === '--headless') out.headless = true;
    else if (a === '--help' || a === '-h') {
      console.log(`
Arena match runner

Usage:
  tsx scripts/run_matches.ts [options]

Options:
  --url <url>        Use an existing server (e.g. http://localhost:5173)
  --serve preview    Build + run \`pnpm preview\` on a free port (default)
  --serve auto       Use an already-running dev server (auto-detect common ports)
  --matches <n>      Total matches (default: 256)
  --sessions <n>     Parallel iframe sessions (default: 16)
  --windows <n>      Alias for --sessions (backward compat)
  --cols <n>         Grid columns (default: 4)
  --rows <n>         Grid rows (default: 4)
  --time <ms>        AI time per move (both sides; default: 1000)
  --time-black <ms>  AI time per move for black (overrides --time)
  --time-white <ms>  AI time per move for white (overrides --time)
  --variant-black <name>  AI variant for black (baseline5s|singleUltra60s|ultraV2_60s)
  --variant-white <name>  AI variant for white (baseline5s|singleUltra60s|ultraV2_60s)
  --swap-half        Swap black/white times for the second half of matches
  --opening <name>   Opening preset (default: long-pro)
  --score <n>        Score to win (default: 1)
  --fast 0|1         Arena mode for embedded games (default: 1)
  --scale <n>        Per-iframe scale (default: 0.5)
  --matrix           Run the built-in gating matrix (scores 1/3/5; swapHalf) and print pass/fail
  --headless         Run Chromium headless (recommended for --matrix)
`.trim());
      process.exit(0);
    }
  }

  const normalizeVariant = (v: AiVariant | null): AiVariant | null => {
    if (!v) return null;
    if (v === 'baseline5s' || v === 'singleUltra60s' || v === 'ultraV2_60s') return v;
    throw new Error(`Invalid variant: ${String(v)}`);
  };
  out.variantBlack = normalizeVariant(out.variantBlack);
  out.variantWhite = normalizeVariant(out.variantWhite);

  out.matches = clampInt(out.matches, 1, 1_000_000);
  out.sessions = clampInt(out.sessions, 1, 256);
  out.cols = clampInt(out.cols, 1, 16);
  out.rows = clampInt(out.rows, 1, 64);
  out.timeMs = clampInt(out.timeMs, 0, 60_000);
  out.timeBlackMs = out.timeBlackMs === null ? null : clampInt(out.timeBlackMs, 0, 60_000);
  out.timeWhiteMs = out.timeWhiteMs === null ? null : clampInt(out.timeWhiteMs, 0, 60_000);
  out.score = clampInt(out.score, 0, 99);
  out.scale = clampFloat(out.scale, 0.25, 1);
  return out;
}

async function getAppName(): Promise<string> {
  const pkgPath = join(PROJECT_ROOT, 'package.json');
  const raw = await readFile(pkgPath, 'utf-8');
  const pkg = JSON.parse(raw);
  return String(pkg?.name ?? 'app');
}

async function waitForHttpOk(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 750);
      const res = await fetch(url, { method: 'GET', signal: controller.signal });
      clearTimeout(t);
      if (res.ok) return;
    } catch {
      // ignore
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function promptYesNo(question: string, defaultYes: boolean): Promise<boolean> {
  if (!process.stdin.isTTY) return defaultYes;
  return await new Promise<boolean>((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      if (a === '') return resolve(defaultYes);
      if (a === 'y' || a === 'yes') return resolve(true);
      if (a === 'n' || a === 'no') return resolve(false);
      return resolve(defaultYes);
    });
  });
}

async function findDevServer(): Promise<string> {
  const ports = [5173, 5174, 5175, 3000, 3001, 4173, 8080];
  for (const port of ports) {
    const url = `http://localhost:${port}`;
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 800);
      const res = await fetch(url, { method: 'GET', signal: controller.signal });
      clearTimeout(t);
      if (res.ok) return url;
    } catch {
      // continue
    }
  }
  const name = await getAppName();
  throw new Error(
    `Could not find a running dev server for ${name}.\n` +
      `Start one with: pnpm dev\n` +
      `Or pass --url http://localhost:PORT`
  );
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close();
        reject(new Error('Failed to get free port'));
        return;
      }
      const port = addr.port;
      server.close(() => resolve(port));
    });
  });
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function newestMtimeMs(pathOrDir: string): Promise<number> {
  const s = await stat(pathOrDir);
  let newest = s.mtimeMs;
  if (!s.isDirectory()) return newest;

  const ignore = new Set<string>([
    '.git',
    '.svelte-kit',
    'node_modules',
    '.pnpm-store',
    'build',
    'dist',
    'coverage',
    '.vite',
  ]);

  const entries = await readdir(pathOrDir, { withFileTypes: true });
  for (const ent of entries) {
    if (ignore.has(ent.name)) continue;
    const p = join(pathOrDir, ent.name);
    try {
      if (ent.isDirectory()) {
        newest = Math.max(newest, await newestMtimeMs(p));
      } else if (ent.isFile()) {
        newest = Math.max(newest, (await stat(p)).mtimeMs);
      }
    } catch {
      // ignore races
    }
  }
  return newest;
}

async function shouldSkipBuild(): Promise<boolean> {
  // Heuristic: if build output exists and is newer than relevant inputs, skip building.
  const outputCandidates = [
    join(PROJECT_ROOT, 'build', 'index.html'),
    join(PROJECT_ROOT, 'dist', 'index.html'),
  ];
  const output = (await (async () => {
    for (const p of outputCandidates) {
      if (await pathExists(p)) return p;
    }
    return null;
  })());
  if (!output) return false;

  const outMtime = (await stat(output)).mtimeMs;
  const inputs = [
    join(PROJECT_ROOT, 'package.json'),
    join(PROJECT_ROOT, 'pnpm-lock.yaml'),
    join(PROJECT_ROOT, 'svelte.config.js'),
    join(PROJECT_ROOT, 'vite.config.ts'),
    join(PROJECT_ROOT, 'tsconfig.json'),
    join(PROJECT_ROOT, 'src'),
    join(PROJECT_ROOT, 'static'),
  ];

  let inMtime = 0;
  for (const p of inputs) {
    if (!(await pathExists(p))) continue;
    inMtime = Math.max(inMtime, await newestMtimeMs(p));
  }
  return outMtime >= inMtime;
}

async function getBuildOutputDir(): Promise<string> {
  const candidates = [join(PROJECT_ROOT, 'build'), join(PROJECT_ROOT, 'dist')];
  for (const dir of candidates) {
    try {
      const s = await stat(dir);
      if (s.isDirectory()) {
        const indexPath = join(dir, 'index.html');
        const idx = await stat(indexPath);
        if (idx.isFile()) return dir;
      }
    } catch {
      // continue
    }
  }
  throw new Error('Could not locate build output directory (expected build/ or dist/ with index.html).');
}

async function snapshotBuildOutput(): Promise<string> {
  const srcDir = await getBuildOutputDir();
  const snapRoot = join(PROJECT_ROOT, '.arena-preview');
  await mkdir(snapRoot, { recursive: true });
  const stamp = isoStampForFilename(new Date());
  const snapDir = join(snapRoot, `snapshot_${stamp}`);
  await cp(srcDir, snapDir, { recursive: true });
  return snapDir;
}

async function runPreviewServer(): Promise<{ baseUrl: string; child: ChildProcessWithoutNullStreams }> {
  // Build first, unless output appears up-to-date.
  if (await shouldSkipBuild()) {
    console.log('[matches] build output looks up-to-date; skipping pnpm build');
  } else {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('pnpm', ['build'], { cwd: PROJECT_ROOT, stdio: 'inherit' });
      child.on('error', reject);
      child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`pnpm build failed (${code})`))));
    });
  }

  // IMPORTANT: snapshot the build directory so later builds cannot break an in-progress run
  // by changing hashed asset filenames while `vite preview` is serving.
  const outDir = await snapshotBuildOutput();
  console.log('[matches] preview snapshot dir:', outDir);

  const port = await getFreePort();
  const origin = `http://127.0.0.1:${port}`;

  // Run Vite directly to avoid passing an extra `--` into Vite (which would disable option parsing).
  const child = spawn(
    'pnpm',
    ['exec', 'vite', 'preview', '--outDir', outDir, '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
    }
  );

  // In preview builds, SvelteKit may be served under a non-empty base path (e.g. `/grr`).
  // Read it from svelte.config.js (SSoT) so we wait on the correct URL.
  const cfgMod = await import(pathToFileURL(join(PROJECT_ROOT, 'svelte.config.js')).href);
  const kitBaseRaw = (cfgMod?.default?.kit?.paths?.base ?? '') as unknown;
  const kitBase = typeof kitBaseRaw === 'string' ? kitBaseRaw : '';
  const basePath = kitBase === '' ? '' : kitBase.startsWith('/') ? kitBase : `/${kitBase}`;
  const baseUrl = `${origin}${basePath}`;

  console.log(`[matches] waiting for preview server at ${baseUrl} ...`);
  await waitForHttpOk(baseUrl, 30_000);
  return { baseUrl, child };
}

function sanitizeFilename(name: string): string {
  // Keep it filesystem-safe and human-readable.
  const trimmed = name.trim().replaceAll('\u0000', '');
  const replaced = trimmed.replaceAll(/[^a-zA-Z0-9._-]+/g, '_');
  const collapsed = replaced.replaceAll(/_+/g, '_').replace(/^-+/, '').replace(/-+$/, '');
  const base = collapsed.length > 0 ? collapsed : 'grr_matches';
  return base.endsWith('.json') ? base : `${base}.json`;
}

function isoStampForFilename(d: Date): string {
  // YYYY-MM-DDTHH-MM-SS (filesystem safe)
  return d.toISOString().replaceAll(':', '-');
}

function buildDefaultReportFilename(args: Args): string {
  const stamp = isoStampForFilename(new Date());
  const black = args.timeBlackMs ?? args.timeMs;
  const white = args.timeWhiteMs ?? args.timeMs;
  const variantTag =
    args.variantBlack || args.variantWhite
      ? `vb${args.variantBlack ?? 'time'}_vw${args.variantWhite ?? 'time'}`
      : null;
  const timeTag =
    args.swapHalf || black !== white
      ? `tb${black}_tw${white}${args.swapHalf ? '_swapHalf' : ''}`
      : `t${args.timeMs}`;
  const tag = variantTag ? `${variantTag}_${timeTag}` : timeTag;
  return sanitizeFilename(
    `grr_${args.opening}_${args.matches}m_${args.sessions}s_${args.cols}x${args.rows}_score${args.score}_${tag}_${stamp}.json`
  );
}

function buildRunKey(args: Args): string {
  const black = args.timeBlackMs ?? args.timeMs;
  const white = args.timeWhiteMs ?? args.timeMs;
  const variantTag =
    args.variantBlack || args.variantWhite
      ? `vb${args.variantBlack ?? 'time'}_vw${args.variantWhite ?? 'time'}`
      : null;
  const timeTag =
    args.swapHalf || black !== white
      ? `tb${black}_tw${white}${args.swapHalf ? '_swapHalf' : ''}`
      : `t${args.timeMs}`;
  const tag = variantTag ? `${variantTag}_${timeTag}` : timeTag;
  const base = sanitizeFilename(
    `grr_${args.opening}_${args.matches}m_${args.sessions}s_${args.cols}x${args.rows}_score${args.score}_${tag}`
  );
  return base.replace(/\.json$/i, '');
}

function buildArenaUrl(baseUrl: string, args: Args): string {
  // baseUrl may include a base path (e.g. http://127.0.0.1:4173/grr).
  // Use a relative URL so we end up at `${basePath}/arena`.
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const u = new URL('arena', base);
  u.searchParams.set('matches', String(args.matches));
  u.searchParams.set('sessions', String(args.sessions));
  u.searchParams.set('cols', String(args.cols));
  u.searchParams.set('rows', String(args.rows));
  u.searchParams.set('time', String(args.timeMs));
  const black = args.timeBlackMs ?? args.timeMs;
  const white = args.timeWhiteMs ?? args.timeMs;
  if (args.swapHalf || black !== args.timeMs || white !== args.timeMs) {
    u.searchParams.set('timeBlack', String(black));
    u.searchParams.set('timeWhite', String(white));
  }
  if (args.variantBlack) {
    u.searchParams.set('variantBlack', args.variantBlack);
  }
  if (args.variantWhite) {
    u.searchParams.set('variantWhite', args.variantWhite);
  }
  if (args.swapHalf) {
    u.searchParams.set('swapHalf', '1');
  }
  u.searchParams.set('opening', args.opening);
  u.searchParams.set('score', String(args.score));
  u.searchParams.set('arena', args.fast ? 'true' : 'false');
  u.searchParams.set('scale', String(args.scale));
  return u.toString();
}

function variantTimeMs(variant: AiVariant): number {
  if (variant === 'baseline5s') return 5000;
  return 60000;
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

function computeEtaMs(completed: number, total: number, elapsedMs: number): number | null {
  const done = Math.max(0, Math.floor(completed));
  const all = Math.max(0, Math.floor(total));
  const remaining = all - done;
  if (remaining <= 0) return 0;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return null;
  if (done < Math.min(8, all)) return null; // avoid noisy early ETAs
  const rate = done / elapsedMs; // matches per ms
  if (!Number.isFinite(rate) || rate <= 0) return null;
  const etaMs = remaining / rate;
  if (!Number.isFinite(etaMs) || etaMs < 0) return null;
  return etaMs;
}

function disablePlaywrightTimeouts(page: Page): void {
  // Use browser-based completion signals instead of arbitrary timeouts.
  page.setDefaultTimeout(0);
  page.setDefaultNavigationTimeout(0);
}

async function openArenaPopup(context: BrowserContext, arenaUrl: string): Promise<Page> {
  const launcher = await context.newPage();
  disablePlaywrightTimeouts(launcher);
  await launcher.goto('about:blank');

  // Open the arena in a popup-style window (minimal chrome) and auto-size to screen.
  const openScript = `(() => {
    const url = ${JSON.stringify(arenaUrl)};
    const s = window.screen;
    const n = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
    const w = n(s.availWidth, n(s.width, 1200));
    const h = n(s.availHeight, n(s.height, 800));
    const x = n(s.availLeft, 0);
    const y = n(s.availTop, 0);
    const features = [
      'popup=yes',
      'menubar=no',
      'toolbar=no',
      'location=no',
      'status=no',
      'scrollbars=no',
      'resizable=yes',
      'noopener=yes',
      'noreferrer=yes',
      'width=' + String(w),
      'height=' + String(h),
      'left=' + String(x),
      'top=' + String(y),
    ].join(',');
    window.open(url, 'grr_arena_' + Date.now() + '_' + Math.random(), features);
  })()`;

  const [arenaPage] = await Promise.all([
    context.waitForEvent('page'),
    launcher.evaluate(openScript),
  ]);

  disablePlaywrightTimeouts(arenaPage);
  await arenaPage.waitForLoadState('domcontentloaded');
  try {
    await arenaPage.bringToFront();
  } catch {
    // ignore
  }
  await launcher.close();
  return arenaPage;
}

function requiredWins(totalGames: number, minWinRateExclusive: number): number {
  // E.g. for 64 games and >0.75 => floor(64*0.75)+1 = 49.
  return Math.floor(totalGames * minWinRateExclusive) + 1;
}

function computeUltraV2WinStats(
  payload: unknown,
  args: Pick<Args, 'matches' | 'swapHalf' | 'variantBlack' | 'variantWhite'>
): {
  total: number;
  wins: number;
  totalAsBlack: number;
  winsAsBlack: number;
  totalAsWhite: number;
  winsAsWhite: number;
} {
  const perMatch = (payload as any)?.perMatch as any[] | undefined;
  if (!Array.isArray(perMatch)) {
    throw new Error('Report missing perMatch array');
  }

  const half = Math.floor(args.matches / 2);
  let total = 0;
  let wins = 0;
  let totalAsBlack = 0;
  let winsAsBlack = 0;
  let totalAsWhite = 0;
  let winsAsWhite = 0;

  for (const r of perMatch) {
    const idx = Number(r?.globalIndex);
    if (!Number.isFinite(idx) || idx < 0) continue;
    const swapped = args.swapHalf && idx >= half;
    const vb = swapped ? args.variantWhite : args.variantBlack;
    const vw = swapped ? args.variantBlack : args.variantWhite;
    const ultraSide: 'black' | 'white' | null =
      vb === 'ultraV2_60s' ? 'black' : vw === 'ultraV2_60s' ? 'white' : null;
    if (ultraSide === null) continue;

    total += 1;
    if (ultraSide === 'black') totalAsBlack += 1;
    else totalAsWhite += 1;

    const winner = r?.winner as unknown;
    if (winner !== 'black' && winner !== 'white') continue; // draws count as non-wins
    if (winner !== ultraSide) continue;

    wins += 1;
    if (ultraSide === 'black') winsAsBlack += 1;
    else winsAsWhite += 1;
  }

  return { total, wins, totalAsBlack, winsAsBlack, totalAsWhite, winsAsWhite };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const outDir = join(PROJECT_ROOT, 'arena-results');
  await mkdir(outDir, { recursive: true });
  const checkpointPath = join(outDir, `${buildRunKey(args)}.checkpoint.json`);

  let restoreCheckpoint: unknown | null = null;
  if (!args.matrix && !args.headless && (await pathExists(checkpointPath))) {
    const resume = await promptYesNo(`[matches] found checkpoint ${checkpointPath}. Resume? [Y/n] `, true);
    if (resume) {
      try {
        restoreCheckpoint = JSON.parse(await readFile(checkpointPath, 'utf-8')) as unknown;
        const count = (restoreCheckpoint as any)?.results?.length;
        if (Number.isFinite(count)) {
          console.log(`[matches] resuming from checkpoint (${count} completed matches)`);
        } else {
          console.log('[matches] resuming from checkpoint');
        }
      } catch (err) {
        console.warn('[matches] failed to read checkpoint; starting fresh', err);
        restoreCheckpoint = null;
      }
    } else {
      console.log('[matches] ignoring checkpoint; starting fresh');
      restoreCheckpoint = null;
    }
  }

  let baseUrl = args.url;
  let previewChild: ChildProcessWithoutNullStreams | null = null;

  if (!baseUrl && args.serve === 'preview') {
    console.log('[matches] starting preview server (no HMR)...');
    const r = await runPreviewServer();
    baseUrl = r.baseUrl;
    previewChild = r.child;
  }

  if (!baseUrl) {
    console.log('[matches] detecting dev server...');
    baseUrl = await findDevServer();
  }

  // Automated modes (matrix/headless) cannot rely on the user to close windows; disable checkpoint resume there.
  const allowCheckpointResume = !(args.headless || args.matrix);
  if (!allowCheckpointResume) {
    restoreCheckpoint = null;
  }

  const chromiumArgs = [
    '--disable-popup-blocking',
    '--disable-infobars',
    '--disable-extensions',
    '--disable-sync',
    '--no-first-run',
    // Best-effort: ensure SharedArrayBuffer isn't disabled by feature flags.
    '--enable-features=SharedArrayBuffer',
  ];

  const runArenaOnceAutomated = async (
    context: BrowserContext,
    runArgs: Args
  ): Promise<{ payload: unknown; outPath: string; arenaUrl: string }> => {
    const arenaUrl = buildArenaUrl(baseUrl, runArgs);
    console.log('[matches] running:', arenaUrl);
    const page: Page = runArgs.headless ? await context.newPage() : await openArenaPopup(context, arenaUrl);
    disablePlaywrightTimeouts(page);
    if (runArgs.headless) {
      await page.goto(arenaUrl, { waitUntil: 'domcontentloaded' });
    }
    let lastLoggedCount = -1;
    let lastLoggedAt = 0;
    const progressInterval = setInterval(() => {
      void (async () => {
        try {
          const checkpoint = (await page.evaluate(
            'window.__grrArenaGetCheckpoint ? window.__grrArenaGetCheckpoint() : null'
          )) as any;
          if (!checkpoint) return;
          const completed = Array.isArray(checkpoint.results) ? checkpoint.results.length : 0;
          const total = Number(checkpoint.config?.matches ?? runArgs.matches);
          const startedAt = Number(checkpoint.startedAt ?? Date.now());
          const elapsedMs = Date.now() - startedAt;
          const etaMs = computeEtaMs(completed, total, elapsedMs);

          const shouldLog =
            completed !== lastLoggedCount ||
            Date.now() - lastLoggedAt >= 60_000;
          if (!shouldLog) return;
          lastLoggedCount = completed;
          lastLoggedAt = Date.now();

          const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
          const etaText = etaMs === null ? '--' : formatEta(etaMs);
          console.log(`[matches] progress ${completed}/${total} (${pct}%) ETA ${etaText}`);
        } catch {
          // ignore transient errors while loading
        }
      })();
    }, 10_000);

    let savedPayload: unknown | null = null;
    let savedOutPath: string | null = null;

    const saveReport = async (payload: unknown, suggestedFilename: string | null): Promise<void> => {
      if (savedOutPath) return;
      const filename = sanitizeFilename(suggestedFilename ?? buildDefaultReportFilename(runArgs));
      const outPath = join(outDir, filename);
      await writeFile(outPath, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
      savedPayload = payload;
      savedOutPath = outPath;
      console.log('[matches] report saved:', outPath);
    };

    // Event-driven save hook (best-effort, avoids races).
    let reportReadyResolve: (() => void) | null = null;
    const reportReady = new Promise<void>(resolve => (reportReadyResolve = resolve));
    await page.exposeFunction('__grrArenaReportReady', async (payload: unknown, filename: unknown) => {
      const suggested = typeof filename === 'string' ? filename : null;
      await saveReport(payload, suggested);
      reportReadyResolve?.();
    });

    try {
      // Browser-based completion signal.
      await Promise.race([reportReady, page.waitForFunction('window.__grrArenaDone === true')]);
    } finally {
      clearInterval(progressInterval);
    }

    if (!savedOutPath) {
      const suggested = (await page.evaluate('window.__grrArenaSuggestedFilename ?? null')) as string | null;
      const payload = (await page.evaluate('window.__grrArenaReport ?? null')) as unknown;
      if (!payload) {
        throw new Error('Arena finished but no report was found on the page');
      }
      await saveReport(payload, suggested);
    }

    await page.close();
    if (!savedPayload || !savedOutPath) {
      throw new Error('Arena finished but report could not be saved');
    }
    return { payload: savedPayload, outPath: savedOutPath, arenaUrl };
  };

  if (args.matrix || args.headless) {
    const browser = await chromium.launch({
      headless: args.headless,
      args: chromiumArgs,
    });

    try {
      const context = await browser.newContext({ viewport: null });
      context.setDefaultTimeout(0);
      context.setDefaultNavigationTimeout(0);

      if (args.matrix) {
        const base: Args = {
          ...args,
          // Keep matrix runs constrained to a single arena session unless explicitly overridden.
          sessions: 1,
          cols: 1,
          rows: 1,
          // Gating defaults: 64 games per score/matchup unless the user explicitly chose otherwise.
          matches: args.matches === 256 ? 64 : args.matches,
          fast: true,
          swapHalf: true,
          headless: args.headless,
        };

        const scorePresets = [1, 3, 5] as const;
        const matchups = [
          { name: 'ultraV2_vs_baseline5s', opponent: 'baseline5s' as const, threshold: 0.75 },
          { name: 'ultraV2_vs_singleUltra60s', opponent: 'singleUltra60s' as const, threshold: 0.66 },
        ] as const;

        let allOk = true;

        for (const score of scorePresets) {
          for (const mu of matchups) {
            const vb: AiVariant = 'ultraV2_60s';
            const vw: AiVariant = mu.opponent;
            const runArgs: Args = {
              ...base,
              score,
              variantBlack: vb,
              variantWhite: vw,
              timeMs: variantTimeMs(vb),
              timeBlackMs: variantTimeMs(vb),
              timeWhiteMs: variantTimeMs(vw),
              swapHalf: true,
            };

            const { payload } = await runArenaOnceAutomated(context, runArgs);
            const stats = computeUltraV2WinStats(payload, runArgs);
            const needOverall = requiredWins(stats.total, mu.threshold);
            const needBlack = requiredWins(stats.totalAsBlack, mu.threshold);
            const needWhite = requiredWins(stats.totalAsWhite, mu.threshold);

            const okOverall = stats.wins >= needOverall;
            const okBlack = stats.winsAsBlack >= needBlack;
            const okWhite = stats.winsAsWhite >= needWhite;

            allOk = allOk && okOverall && okBlack && okWhite;

            console.log('[matrix]', {
              scoreToWin: score,
              matchup: mu.name,
              games: stats.total,
              wins: stats.wins,
              required: needOverall,
              asBlack: `${stats.winsAsBlack}/${stats.totalAsBlack} (need ${needBlack})`,
              asWhite: `${stats.winsAsWhite}/${stats.totalAsWhite} (need ${needWhite})`,
              pass: okOverall && okBlack && okWhite,
            });
          }
        }

        if (!allOk) {
          process.exitCode = 1;
        }
      } else {
        await runArenaOnceAutomated(context, args);
      }
    } finally {
      await browser.close();
      if (previewChild) {
        previewChild.kill('SIGTERM');
      }
    }

    return;
  }

  const arenaUrl = buildArenaUrl(baseUrl, args);
  console.log('[matches] opening arena:', arenaUrl);
  console.log('[matches] results will be saved to disk when finished.');
  console.log('[matches] do not close the arena window until you see "[matches] report saved: ..."');
  console.log('[matches] close the browser window when you are done.');

  const browser = await chromium.launch({
    headless: false,
    args: chromiumArgs,
  });

  try {
    const context = await browser.newContext({ viewport: null });
    context.setDefaultTimeout(0);
    context.setDefaultNavigationTimeout(0);

    if (restoreCheckpoint) {
      await context.addInitScript(`(() => {
        try { window.__grrArenaRestore = ${JSON.stringify(restoreCheckpoint)}; } catch {}
      })();`);
    }

    // Forward runtime errors from the arena page AND its iframes to this Node console.
    // This makes iframe failures visible even when DevTools is closed.
    await context.exposeBinding('__grrNodeLog', (_source, payload) => {
      const p = payload as any;
      const href = typeof p?.href === 'string' ? p.href : '';
      const kind = typeof p?.kind === 'string' ? p.kind : 'error';
      const message =
        typeof p?.message === 'string'
          ? p.message
          : typeof p?.reason === 'string'
            ? p.reason
            : '';

      let tag = 'arena';
      try {
        const u = new URL(href);
        const session = u.searchParams.get('session');
        const match = u.searchParams.get('match');
        if (session !== null || match !== null) {
          tag = `iframe s${session ?? '?'} m${match ?? '?'}`;
        } else if (u.pathname.endsWith('/arena') || u.pathname.includes('/arena')) {
          tag = 'arena';
        } else if (u.pathname === '/' || u.pathname.endsWith('/')) {
          tag = 'game';
        }
      } catch {
        // ignore parse errors
      }

      const loc =
        typeof p?.filename === 'string' && Number.isFinite(p?.lineno)
          ? ` (${p.filename}:${p.lineno}${Number.isFinite(p?.colno) ? `:${p.colno}` : ''})`
          : '';

      console.error(`[${tag}] ${kind}: ${message}${loc}`);
      if (typeof p?.stack === 'string' && p.stack.trim().length > 0) {
        console.error(p.stack);
      }
    });

    await context.addInitScript(`(() => {
      const send = (kind, info) => {
        try {
          const fn = window.__grrNodeLog;
          if (typeof fn !== 'function') return;
          // Fire-and-forget; avoid blocking the page.
          void fn({ kind, href: location.href, ...info });
        } catch {
          // ignore
        }
      };

      window.addEventListener('error', (ev) => {
        try {
          send('error', {
            message: String(ev.message ?? 'error'),
            filename: ev.filename ?? '',
            lineno: ev.lineno ?? 0,
            colno: ev.colno ?? 0,
            stack: ev.error && ev.error.stack ? String(ev.error.stack) : '',
          });
        } catch {
          // ignore
        }
      });

      window.addEventListener('unhandledrejection', (ev) => {
        try {
          const r = ev.reason;
          send('unhandledrejection', {
            reason: r && r.stack ? String(r.stack) : String(r),
          });
        } catch {
          // ignore
        }
      });
    })();`);

    const arenaPage = await openArenaPopup(context, arenaUrl);

    let saved = false;
    let savedPath: string | null = null;

    const saveReport = async (payload: unknown, suggestedFilename: string | null): Promise<void> => {
      if (saved) return;
      const filename = sanitizeFilename(suggestedFilename ?? buildDefaultReportFilename(args));
      const outPath = join(outDir, filename);
      const json = JSON.stringify(payload, null, 2) + '\n';
      await writeFile(outPath, json, 'utf-8');
      saved = true;
      savedPath = outPath;

      const summary = (payload as any)?.summary ?? {};
      console.log('[matches] report saved:', outPath);
      console.log('[matches] summary:', {
        blackWins: summary.blackWins,
        whiteWins: summary.whiteWins,
        draws: summary.draws,
        elapsedMs: summary.elapsedMs,
      });

      // Clear checkpoint on success (prevents accidental resume into a completed run).
      try {
        await rm(checkpointPath, { force: true });
      } catch {
        // ignore
      }
    };

    // Event-driven save hook (avoids races with page close).
    await arenaPage.exposeFunction('__grrArenaReportReady', async (payload: unknown, filename: unknown) => {
      const suggested = typeof filename === 'string' ? filename : null;
      await saveReport(payload, suggested);
    });

    // Fallback: poll for done and then pull from the page once.
    const fallbackSavePromise = (async () => {
      try {
        await arenaPage.waitForFunction('window.__grrArenaDone === true');
        if (saved) return;
        const suggested = (await arenaPage.evaluate('window.__grrArenaSuggestedFilename ?? null')) as string | null;
        const payload = (await arenaPage.evaluate('window.__grrArenaReport ?? null')) as unknown;
        if (!payload) {
          console.warn('[matches] arena signaled done, but no report was found on the page.');
          return;
        }
        await saveReport(payload, suggested);
      } catch {
        // Most likely the page was closed before completion.
      }
    })();

    const getCheckpoint = async (): Promise<any | null> => {
      try {
        const payload = (await arenaPage.evaluate(
          'window.__grrArenaGetCheckpoint ? window.__grrArenaGetCheckpoint() : null'
        )) as unknown;
        if (!payload || typeof payload !== 'object') return null;
        return payload as any;
      } catch {
        return null;
      }
    };

    // Periodic checkpoint writer (best-effort). Resuming restarts any in-flight games.
    const checkpointWriteOnce = async (): Promise<void> => {
      try {
        const payload = await getCheckpoint();
        if (!payload) return;
        const json = JSON.stringify(payload, null, 2) + '\n';
        const tmp = `${checkpointPath}.tmp`;
        await writeFile(tmp, json, 'utf-8');
        await rename(tmp, checkpointPath);
      } catch {
        // ignore transient errors (page navigation/closed)
      }
    };

    // Periodic progress/ETA logger (console UX).
    let lastLoggedCount = -1;
    let lastLoggedAt = 0;
    const logProgressOnce = async (): Promise<void> => {
      if (saved) return;
      const payload = await getCheckpoint();
      if (!payload) return;

      const completed = Array.isArray(payload.results) ? payload.results.length : 0;
      const total = Number(payload.config?.matches ?? args.matches);
      const startedAtMs = Number(payload.startedAt ?? Date.now());
      const elapsedMs = Date.now() - startedAtMs;
      const etaMs = computeEtaMs(completed, total, elapsedMs);

      const shouldLog = completed !== lastLoggedCount || Date.now() - lastLoggedAt >= 60_000;
      if (!shouldLog) return;
      lastLoggedCount = completed;
      lastLoggedAt = Date.now();

      const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
      const etaText = etaMs === null ? '--' : formatEta(etaMs);
      console.log(`[matches] progress ${completed}/${total} (${pct}%) ETA ${etaText}`);
    };

    // Write a first checkpoint shortly after start.
    await checkpointWriteOnce();
    const checkpointInterval = setInterval(() => {
      if (saved) return;
      void checkpointWriteOnce();
    }, 60_000);

    // Start an ETA ticker (more frequent than checkpoint writes).
    await logProgressOnce();
    const progressInterval = setInterval(() => {
      if (saved) return;
      void logProgressOnce();
    }, 10_000);

    const closePromise = arenaPage.waitForEvent('close', { timeout: 0 });
    await closePromise;
    clearInterval(checkpointInterval);
    clearInterval(progressInterval);

    // Try one last checkpoint on close, in case we never saved a final report.
    if (!saved) {
      await checkpointWriteOnce();
    }

    // If we didn't save, warn loudly (prevents silent loss).
    if (!saved) {
      console.warn('[matches] arena window closed before report was saved.');
      console.warn('[matches] (if the arena finished, re-run and wait for the "[matches] report saved:" line before closing.)');
    } else if (savedPath) {
      console.log('[matches] saved at:', savedPath);
    }

    // Best-effort: let any in-flight save finish.
    await Promise.race([
      fallbackSavePromise,
      new Promise<void>(resolve => setTimeout(resolve, 2000)),
    ]);
  } finally {
    await browser.close();
    if (previewChild) {
      previewChild.kill('SIGTERM');
    }
  }
}

main().catch(err => {
  console.error('[matches] fatal:', err);
  process.exit(1);
});
