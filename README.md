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
  - The app/worker will try to load `/nnue/weights.bin`. If missing/corrupt, NNUE is disabled and the AI falls back to handcrafted eval/search.

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
