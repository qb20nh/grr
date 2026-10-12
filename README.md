# sv

Everything you need to build a Svelte project, powered by [`sv`](https://github.com/sveltejs/cli).

## Creating a project

If you're seeing this, you've probably already done this step. Congrats!

```sh
# create a new project in the current directory
npx sv create

# create a new project in my-app
npx sv create my-app
```

## Developing

Once you've created a project and installed dependencies with `npm install` (or `pnpm install` or `yarn`), start a development server:

```sh
npm run dev

# or start the server and open the app in a new browser tab
npm run dev -- --open
```

## Building

To create a production version of your app:

```sh
npm run build
```

You can preview the production build with `npm run preview`.

> To deploy your app, you may need to install an [adapter](https://svelte.dev/docs/kit/adapters) for your target environment.

## Ultra mode (60s) – strongest search prerequisites

The **Ultra** thinking-time option uses a **60s capped** search. For the strongest Ultra (shared transposition table across workers), the runtime needs `SharedArrayBuffer`, which in browsers requires **cross-origin isolation**:

- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`

This repo sets these headers automatically for `vite dev` and `vite preview` (see `vite.config.ts`). For static hosting, `static/_headers` is included for hosts that support it (e.g. Netlify/Cloudflare Pages). If your host can’t set these headers, Ultra will fall back to the non-shared implementation.

## Training (self-play → NNUE → Elo-gated promotion)

This repo includes an **offline self-improvement loop** that:

- generates self-play data
- trains a compact NNUE value net (PyTorch)
- evaluates the new weights vs the current best using **match-play Elo + bootstrap CI**
- promotes the candidate only if **CI low > 0 Elo**

### Setup (Python)

Create a venv and install deps:

```sh
python -m venv .venv
. .venv/bin/activate
pip install -r training/nnue/requirements.txt
```

### Run one improvement cycle

```sh
python training/cycle.py --cycles 1 --games 50
```

- First run bootstraps automatically (no best weights yet).
- Subsequent runs evaluate **candidate vs best** and only promote when statistically better.

### Where weights live

- **Best (canonical)**: `training/best/weights.bin`
- **App-consumed (bundled when present)**: `static/nnue/weights.bin`
  - The optional loader resolves `(<base>/nnue/weights.bin)`. Current browser workers explicitly use handcrafted evaluation; the search/training API can accept NNUE weights. The loader returns null for missing/corrupt weights.
    - Dev: `/nnue/weights.bin`
    - Prod (this repo’s static base path): `/grr/nnue/weights.bin`

## Dashboard

Start the standalone dashboard server:

```sh
python training/dashboard/server.py --port 8787
```

Then open `http://127.0.0.1:8787`.

The dashboard reads run metadata from `training/runs/index.json` and per-run `summary.json`.

### Orchestrate cycles from the dashboard

The dashboard includes a small control panel to start training cycles using presets from `training/presets.json`:

- **fast**: quick iteration (small self-play + light eval)
- **balanced**: default baseline
- **rigorous**: slower but higher-confidence eval

Click **Start** to run `training/cycle.py` with the selected preset. The UI shows live logs and will refresh the runs list when the job finishes.

## AI verification and comparison

```sh
pnpm test:ai
pnpm bench:ai
pnpm check
pnpm build
```

`test:ai` covers exact-five/overline detection, ko, legal pair-scoring equivalence,
bounded tactical search, PVS bounds, opening-filter cache isolation, NNUE scoring
and undo, and concurrent shared-TT writers, followed by the tactical puzzles.
The benchmark warms up JavaScript and resets TT/history between measured searches.

To compare an older checkout with the current engine:

```sh
node --import tsx scripts/compare_ai.mjs --reference ../grr-baseline --games 16 --time 100
```

This prints JSON lines for equal-work move-generation timings and color-swapped
matches from paired openings. Matches use a one-point target, an 80-ply cap and
threefold-repetition adjudication. Illegal scoring singles are reported as
forfeits; this harness does not model the UI's fallback for rejected moves.
These small, time-limited matches are a regression check, not an Elo estimate.
