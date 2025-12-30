import argparse
import json
import math
from pathlib import Path
from typing import Any

import random


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Compute Elo + bootstrap CI from matchplay.json")
    p.add_argument("--matchplay", required=True, help="Path to matchplay.json")
    p.add_argument("--out", required=True, help="Output elo.json path")
    p.add_argument("--bootstrap", type=int, default=2000, help="Bootstrap samples (default: 2000)")
    p.add_argument("--seed", type=int, default=1)
    return p.parse_args()


def elo_from_score(p: float) -> float:
    # Clamp to avoid infinities.
    eps = 1e-6
    p = min(1.0 - eps, max(eps, p))
    return 400.0 * math.log10(p / (1.0 - p))


def percentile(xs: list[float], q: float) -> float:
    if not xs:
        return float("nan")
    xs_sorted = sorted(xs)
    k = int(round((len(xs_sorted) - 1) * q))
    k = max(0, min(len(xs_sorted) - 1, k))
    return xs_sorted[k]


def main() -> None:
    args = parse_args()
    mp = json.loads(Path(args.matchplay).read_text(encoding="utf-8"))
    res = mp.get("results", {})
    wins_a = int(res.get("winsA", 0))
    wins_b = int(res.get("winsB", 0))
    draws = int(res.get("draws", 0))
    games = int(mp.get("games", wins_a + wins_b + draws))
    if games <= 0:
        raise ValueError("matchplay has no games")

    score = (wins_a + 0.5 * draws) / games
    elo = elo_from_score(score)

    # Bootstrap CI over per-game outcomes.
    # outcomes: 1 (A win), 0.5 (draw), 0 (A loss)
    outcomes: list[float] = [1.0] * wins_a + [0.5] * draws + [0.0] * wins_b
    if len(outcomes) != games:
        # Fallback: use perGame if present
        per_game = mp.get("perGame", [])
        outcomes = []
        for g in per_game:
            w = g.get("winner")
            if w == "A":
                outcomes.append(1.0)
            elif w == "B":
                outcomes.append(0.0)
            else:
                outcomes.append(0.5)
        games = len(outcomes)
        if games <= 0:
            raise ValueError("could not derive outcomes")

    rng = random.Random(args.seed)
    samples: list[float] = []
    for _ in range(int(args.bootstrap)):
        s = 0.0
        for _i in range(games):
            s += outcomes[rng.randrange(games)]
        samples.append(elo_from_score(s / games))

    ci_low = percentile(samples, 0.025)
    ci_high = percentile(samples, 0.975)

    out: dict[str, Any] = {
        "matchplay": str(args.matchplay),
        "games": games,
        "winsA": wins_a,
        "winsB": wins_b,
        "draws": draws,
        "scoreA": score,
        "elo": elo,
        "ci_low": ci_low,
        "ci_high": ci_high,
        "bootstrap_samples": int(args.bootstrap),
        "seed": args.seed,
    }

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print("[elo]", {"elo": elo, "ci_low": ci_low, "ci_high": ci_high, "games": games})


if __name__ == "__main__":
    main()

