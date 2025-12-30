import argparse
import json
import os
import subprocess
import sys
import time
import shutil
from typing import Iterable
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path


def run(cmd: list[str]) -> None:
    print("$", " ".join(cmd))
    subprocess.check_call(cmd)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Self-play -> train -> eval -> promote NNUE weights (rigorous improvement).")

    p.add_argument("--cycles", type=int, default=1)
    p.add_argument("--seed", type=int, default=1)

    p.add_argument("--preset", default="", help="Optional preset: fast|balanced|rigorous (see training/presets.json)")

    p.add_argument("--runsDir", default="training/runs")
    p.add_argument("--bestWeights", default="training/best/weights.bin")
    p.add_argument("--bestCheckpoint", default="training/best/model.pt")
    p.add_argument("--staticWeights", default="static/nnue/weights.bin")
    p.add_argument("--jsRuntime", default="auto", help="JS runtime for selfplay/matchplay: auto|bun|node")

    # Self-play generation
    # Defaults aim for “compact but effective” training data volume.
    p.add_argument("--games", type=int, default=200)
    p.add_argument("--maxPlies", type=int, default=600)
    p.add_argument("--selfplayWorkers", type=int, default=0, help="Parallel shards for self-play (0 = auto)")

    # Default bootstrap behavior:
    # - If weights exist: epsilon-greedy search
    # - Else: softmax sampling over heuristic move scores (very noisy)
    p.add_argument("--policy", default="", help="Override policy: random|softmax|epsilon|search")
    p.add_argument("--topK", type=int, default=40)
    p.add_argument("--temperature", type=float, default=3.0)
    p.add_argument("--epsilon", type=float, default=0.25)
    p.add_argument("--timeMs", type=int, default=25)
    p.add_argument("--maxDepth", type=int, default=6)

    # Training
    p.add_argument("--hiddenDim", type=int, default=128)
    p.add_argument("--epochs", type=int, default=5)
    p.add_argument("--batchSize", type=int, default=2048)
    p.add_argument("--lr", type=float, default=1e-3)
    p.add_argument("--device", default="cpu")

    # Evaluation (match-play)
    p.add_argument("--evalGames", type=int, default=400)
    p.add_argument("--evalSeed", type=int, default=12345)
    p.add_argument("--evalTimeMs", type=int, default=50)
    p.add_argument("--evalMaxDepth", type=int, default=8)
    p.add_argument("--evalMaxPlies", type=int, default=800)
    p.add_argument("--evalOpeningPlies", type=int, default=4)
    p.add_argument("--evalOpeningTopK", type=int, default=12)
    p.add_argument("--eloBootstrap", type=int, default=4000)
    p.add_argument("--evalWorkers", type=int, default=0, help="Parallel shards for match-play eval (0 = auto)")

    return p.parse_args()

@dataclass(frozen=True)
class PromotionDecision:
    promoted: bool
    reason: str
    elo: float | None = None
    ci_low: float | None = None
    ci_high: float | None = None


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def utc_compact(ts: datetime) -> str:
    return ts.strftime("%Y%m%d-%H%M%SZ")


def read_json(path: Path, default: object) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def write_json(path: Path, obj: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, sort_keys=True) + "\n", encoding="utf-8")

def load_presets() -> dict:
    presets_path = Path("training/presets.json")
    return json.loads(presets_path.read_text(encoding="utf-8"))


def apply_preset(args: argparse.Namespace) -> None:
    if not args.preset:
        return
    presets = load_presets()
    preset = presets.get(args.preset)
    if not isinstance(preset, dict):
        raise SystemExit(f"Unknown preset: {args.preset}")
    preset_args = preset.get("args")
    if not isinstance(preset_args, dict):
        raise SystemExit(f"Preset {args.preset} has no args")

    # Overwrite selected knobs. This is intentionally explicit so the preset file
    # cannot set arbitrary attributes.
    allowed = {
        "games",
        "maxPlies",
        "selfplayWorkers",
        "topK",
        "temperature",
        "epsilon",
        "timeMs",
        "maxDepth",
        "hiddenDim",
        "epochs",
        "batchSize",
        "lr",
        "evalGames",
        "evalTimeMs",
        "evalMaxDepth",
        "evalOpeningPlies",
        "eloBootstrap",
        "evalWorkers",
    }
    for k, v in preset_args.items():
        if k not in allowed:
            continue
        setattr(args, k, v)


def auto_workers() -> int:
    """
    Return an estimate of physical core count (best-effort).

    On Linux, we try to count unique (physical id, core id) pairs from /proc/cpuinfo.
    Fallback is os.cpu_count() (logical cores).
    """
    # Linux: try /proc/cpuinfo.
    if sys.platform.startswith("linux"):
        try:
            phys_cores: set[tuple[str, str]] = set()
            physical_id: str | None = None
            core_id: str | None = None

            with open("/proc/cpuinfo", "r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    s = line.strip()
                    if not s:
                        if physical_id is not None and core_id is not None:
                            phys_cores.add((physical_id, core_id))
                        physical_id = None
                        core_id = None
                        continue

                    if s.startswith("physical id"):
                        physical_id = s.split(":", 1)[1].strip()
                    elif s.startswith("core id"):
                        core_id = s.split(":", 1)[1].strip()

            if physical_id is not None and core_id is not None:
                phys_cores.add((physical_id, core_id))

            if phys_cores:
                return max(1, len(phys_cores))
        except OSError:
            pass

    return max(1, os.cpu_count() or 1)


def choose_js_runtime(mode: str) -> str:
    m = (mode or "").strip().lower()
    if m in ("node", "bun"):
        if shutil.which(m) is None:
            raise SystemExit(f"Requested JS runtime '{m}' not found in PATH")
        return m
    # auto
    if shutil.which("bun") is not None:
        return "bun"
    return "node"

@dataclass(frozen=True)
class BundledTools:
    generate_dataset: Path
    matchplay: Path


def bundle_ts(entry: str, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    run(
        [
            "pnpm",
            "-s",
            "exec",
            "esbuild",
            entry,
            "--bundle",
            "--platform=node",
            "--format=esm",
            "--target=es2022",
            f"--outfile={out}",
        ]
    )


def ensure_bundled_tools() -> BundledTools:
    """
    Build the TS tooling into single-file Node-friendly ESM scripts.
    """
    run(["pnpm", "-s", "exec", "tsc", "-p", "training/selfplay/tsconfig.json", "--noEmit"])
    out_dir = Path("training/dist/selfplay")
    out_dir.mkdir(parents=True, exist_ok=True)
    gen = out_dir / "generate_dataset.mjs"
    mp = out_dir / "matchplay.mjs"
    bundle_ts("training/selfplay/generate_dataset.ts", gen)
    bundle_ts("training/selfplay/matchplay.ts", mp)
    if not gen.exists():
        raise FileNotFoundError(str(gen))
    if not mp.exists():
        raise FileNotFoundError(str(mp))
    return BundledTools(generate_dataset=gen, matchplay=mp)


def update_runs_index(runs_dir: Path, entry: dict) -> None:
    index_path = runs_dir / "index.json"
    idx = read_json(index_path, {"runs": []})
    if not isinstance(idx, dict) or "runs" not in idx or not isinstance(idx["runs"], list):
        idx = {"runs": []}
    idx["runs"].append(entry)
    write_json(index_path, idx)


def main() -> None:
    args = parse_args()
    apply_preset(args)

    if args.selfplayWorkers <= 0:
        # Use all physical cores by default, but don't spawn more shards than games.
        args.selfplayWorkers = min(auto_workers(), max(1, int(args.games)))
    if args.evalWorkers <= 0:
        # Use all physical cores by default, but don't spawn more shards than eval games.
        args.evalWorkers = min(auto_workers(), max(1, int(args.evalGames)))

    js = choose_js_runtime(args.jsRuntime)

    tools = ensure_bundled_tools()

    runs_dir = Path(args.runsDir)
    best_weights_path = Path(args.bestWeights)
    best_ckpt_path = Path(args.bestCheckpoint)
    static_weights_path = Path(args.staticWeights)
    best_weights_path.parent.mkdir(parents=True, exist_ok=True)
    best_ckpt_path.parent.mkdir(parents=True, exist_ok=True)
    static_weights_path.parent.mkdir(parents=True, exist_ok=True)

    for c in range(args.cycles):
        cycle_seed = args.seed + c
        started_at = utc_now()
        run_id = f"{utc_compact(started_at)}-seed{cycle_seed}-c{c+1}"

        run_dir = runs_dir / run_id
        (run_dir / "selfplay").mkdir(parents=True, exist_ok=True)
        (run_dir / "train").mkdir(parents=True, exist_ok=True)
        (run_dir / "eval").mkdir(parents=True, exist_ok=True)
        (run_dir / "artifacts").mkdir(parents=True, exist_ok=True)

        dataset_path = run_dir / "selfplay" / "dataset.bin"
        ckpt_path = run_dir / "train" / "model.pt"
        candidate_weights_path = run_dir / "artifacts" / "weights_candidate.bin"

        have_best = best_weights_path.exists()
        have_best_ckpt = best_ckpt_path.exists()

        policy = args.policy.strip()
        if not policy:
            policy = "epsilon" if have_best else "softmax"

        config = {
            "runId": run_id,
            "startedAt": started_at.isoformat(),
            "seed": cycle_seed,
            "preset": args.preset or None,
            "selfplay": {
                "games": args.games,
                "maxPlies": args.maxPlies,
                "workers": args.selfplayWorkers,
                "policy": policy,
                "topK": args.topK,
                "temperature": args.temperature,
                "epsilon": args.epsilon,
                "timeMs": args.timeMs,
                "maxDepth": args.maxDepth,
                "bestWeightsUsed": str(best_weights_path) if have_best else None,
            },
            "train": {
                "hiddenDim": args.hiddenDim,
                "epochs": args.epochs,
                "batchSize": args.batchSize,
                "lr": args.lr,
                "device": args.device,
            },
            "eval": {
                "games": args.evalGames,
                "seed": args.evalSeed + cycle_seed,
                "timeMs": args.evalTimeMs,
                "maxDepth": args.evalMaxDepth,
                "maxPlies": args.evalMaxPlies,
                "openingPlies": args.evalOpeningPlies,
                "openingTopK": args.evalOpeningTopK,
                "eloBootstrap": args.eloBootstrap,
                "promoteIfCiLowGt": 0.0,
                "workers": args.evalWorkers,
            },
            "paths": {
                "runDir": str(run_dir),
                "dataset": str(dataset_path),
                "checkpoint": str(ckpt_path),
                "candidateWeights": str(candidate_weights_path),
                "bestWeights": str(best_weights_path),
                "bestCheckpoint": str(best_ckpt_path),
                "staticWeights": str(static_weights_path),
            },
            "versions": {
                "python": sys.version.split()[0],
                "jsRuntime": js,
            },
        }
        write_json(run_dir / "config.json", config)

        # Self-play
        sp_cmd = [
            js,
            str(tools.generate_dataset),
            "--out",
            str(dataset_path),
            "--games",
            str(args.games),
            "--maxPlies",
            str(args.maxPlies),
            "--seed",
            str(cycle_seed),
            "--shards",
            str(args.selfplayWorkers),
            "--policy",
            policy,
            "--topK",
            str(args.topK),
            "--temperature",
            str(args.temperature),
            "--epsilon",
            str(args.epsilon),
            "--timeMs",
            str(args.timeMs),
            "--maxDepth",
            str(args.maxDepth),
        ]
        if have_best:
            sp_cmd += ["--weights", str(best_weights_path)]
        run(sp_cmd)

        # Train
        train_cmd = [
            "python",
            "training/nnue/train.py",
            "--dataset",
            str(dataset_path),
            "--out",
            str(ckpt_path),
            "--hiddenDim",
            str(args.hiddenDim),
            "--epochs",
            str(args.epochs),
            "--batchSize",
            str(args.batchSize),
            "--lr",
            str(args.lr),
            "--seed",
            str(cycle_seed),
            "--device",
            str(args.device),
        ]
        # Default: warm-start from best checkpoint when available.
        if have_best_ckpt:
            train_cmd += ["--init", str(best_ckpt_path)]

        run(
            [
                *train_cmd,
            ]
        )

        train_log_path = run_dir / "train" / "log.jsonl"
        train_last: dict | None = None
        try:
            lines = train_log_path.read_text(encoding="utf-8").strip().splitlines()
            if lines:
                train_last = json.loads(lines[-1])
        except FileNotFoundError:
            train_last = None

        # Export weights
        run(
            [
                "python",
                "training/nnue/export_weights.py",
                "--checkpoint",
                str(ckpt_path),
                "--out",
                str(candidate_weights_path),
            ]
        )

        eval_out: dict | None = None

        # Promotion logic with Elo gating (candidate vs best).
        if not have_best:
            best_weights_path.write_bytes(candidate_weights_path.read_bytes())
            best_ckpt_path.write_bytes(ckpt_path.read_bytes())
            static_weights_path.write_bytes(candidate_weights_path.read_bytes())
            decision = PromotionDecision(promoted=True, reason="bootstrap: no best weights existed yet")
        else:
            matchplay_path = run_dir / "eval" / "matchplay.json"
            elo_path = run_dir / "eval" / "elo.json"
            eval_seed = int(config["eval"]["seed"])

            run(
                [
                    js,
                    str(tools.matchplay),
                    "--a",
                    str(candidate_weights_path),
                    "--b",
                    str(best_weights_path),
                    "--out",
                    str(matchplay_path),
                    "--games",
                    str(args.evalGames),
                    "--seed",
                    str(eval_seed),
                    "--timeMs",
                    str(args.evalTimeMs),
                    "--maxDepth",
                    str(args.evalMaxDepth),
                    "--maxPlies",
                    str(args.evalMaxPlies),
                    "--openingPlies",
                    str(args.evalOpeningPlies),
                    "--openingTopK",
                    str(args.evalOpeningTopK),
                    "--shards",
                    str(args.evalWorkers),
                ]
            )

            run(
                [
                    "python",
                    "training/elo.py",
                    "--matchplay",
                    str(matchplay_path),
                    "--out",
                    str(elo_path),
                    "--bootstrap",
                    str(args.eloBootstrap),
                    "--seed",
                    str(eval_seed),
                ]
            )

            elo_json = json.loads(elo_path.read_text(encoding="utf-8"))
            elo = float(elo_json.get("elo"))
            ci_low = float(elo_json.get("ci_low"))
            ci_high = float(elo_json.get("ci_high"))
            eval_out = {
                "matchplay": str(matchplay_path),
                "elo": str(elo_path),
                "elo_value": elo,
                "ci_low": ci_low,
                "ci_high": ci_high,
            }

            if ci_low > 0.0:
                best_weights_path.write_bytes(candidate_weights_path.read_bytes())
                best_ckpt_path.write_bytes(ckpt_path.read_bytes())
                static_weights_path.write_bytes(candidate_weights_path.read_bytes())
                decision = PromotionDecision(
                    promoted=True,
                    reason="promoted: ci_low > 0 Elo vs best",
                    elo=elo,
                    ci_low=ci_low,
                    ci_high=ci_high,
                )
            else:
                decision = PromotionDecision(
                    promoted=False,
                    reason="rejected: ci_low <= 0 Elo vs best",
                    elo=elo,
                    ci_low=ci_low,
                    ci_high=ci_high,
                )

        ended_at = utc_now()
        summary = {
            "runId": run_id,
            "startedAt": started_at.isoformat(),
            "endedAt": ended_at.isoformat(),
            "config": config,
            "artifacts": {
                "candidateWeights": str(candidate_weights_path),
            },
            "train": {
                "checkpoint": str(ckpt_path),
                "log": str(train_log_path),
                "last": train_last,
            },
            "eval": eval_out,
            "promotion": asdict(decision),
        }
        write_json(run_dir / "summary.json", summary)
        update_runs_index(
            runs_dir,
            {
                "runId": run_id,
                "startedAt": started_at.isoformat(),
                "endedAt": ended_at.isoformat(),
                "summary": f"{run_id}/summary.json",
                "promoted": decision.promoted,
                "elo": decision.elo,
                "ci_low": decision.ci_low,
                "ci_high": decision.ci_high,
            },
        )

        print("[cycle] complete", {"cycle": c + 1, "runId": run_id, "promoted": decision.promoted})


if __name__ == "__main__":
    main()

