# Search throughput and isolated match validation

This round compares with `d50a97e7efca1ea313523af88e4c03160594d914`, the
previous head of PR #2. Measurements use bundled Node v24.19.0 on 2026-10-13.
The engine still uses handcrafted evaluation. Search depth limits, pruning,
evaluation weights and tactical candidate limits are unchanged.

## Changes

The winning-square scanner visits each backward gap only when it can add a new
result. Full-board scans visit origins in ascending order and all four direction
offsets are positive, so the earlier run already discovers a gap shared by two
runs. Local post-move scans still inspect both ends, but count each side only
once. Endpoints with too little remaining space cannot complete an exact five.
Winning-square order, exact-five rules and Ko behavior are preserved.

Move generation shares the unchanged parent's winning-square lists across
immediate responses, reinforce scoring and rift scoring. Temporary child-board
probes still scan their own state. The lists live for one generation call;
they do not depend on a position hash that helper mutations may leave unchanged.

Search reuses base root candidates across iterative depths, aspiration retries,
root widening and pondering slices. Dynamic ordering receives fresh wrappers
and reapplies current TT, history and killer bonuses. Opening filters and remote
fallbacks retain their existing behavior. Pondering resets candidates when the
position changes. The match-score component of cache keys is updated only when
points change, then restored with the move undo.

Blocking masks scan each contiguous run once. Rift evaluation uses the existing
category-only pattern scanner. Pattern counting also avoids finding a run's
start a second time after its loop has already established it.

## Performance

`scripts/compare_search.mjs` bundles both versions, clears TT and move ordering
before every search, and alternates their execution order. One unmeasured round
precedes nine measured rounds. The deadline is disabled and main depth is two.
All repetitions agree exactly on the selected move, score, completed depth and
node count, and restore the complete board.

| Position | Previous median ms | Current median ms | Nodes in either version |
| --- | ---: | ---: | ---: |
| Opening center cluster | 85.651 | 79.231 | 1,894 |
| Tactical fork position | 8.711 | 8.233 | 169 |
| Ko edge defense | 24.267 | 23.313 | 802 |
| Dense midgame | 74.442 | 71.021 | 1,239 |
| Multi-point scoring | 48.685 | 46.994 | 400 |
| Restricted Long Pro | 5.453 | 5.221 | 106 |
| Sum of medians | 247.210 | 234.013 | 4,610 |

This fixed-work workload takes **5.3% less elapsed time** (1.056x speed).
It covers six fixtures; it is not a universal speed multiplier.

The existing four-position timed benchmark uses five repetitions at 400 ms,
main depth at most ten, warmup, and fresh TT/history per repetition:

| Position | Previous nodes/s | Current nodes/s | Previous completed depth | Current completed depth |
| --- | ---: | ---: | ---: | ---: |
| Opening center cluster | 13,772 | 14,877 | 4 | 4 |
| Tactical fork position | 17,182 | 18,578 | 5 | 5 |
| Ko edge defense | 12,969 | 13,959 | 3 | 3 |
| Dense midgame | 15,905 | 18,109 | 2 | 3 |
| Aggregate | 14,956 | 16,381 | | |

Aggregate throughput rises **9.5%**. These searches do different amounts of
work at the same deadline, so the fixed-work comparison above is the stronger
evidence about cost. Timings are machine-specific and remain noisy.

An earlier candidate used lazy getters for parent winning squares and lacked
the final winning-scanner change. It measured 0.992x fixed-work speed and +1.3%
timed throughput, too small to support a gain. Replacing getters with plain
arrays measured 1.020x fixed-work speed before the final scanner change.
No match games were used to select these optimizations. Intermediate timings
are retained separately in the result artifact.

## Match methodology and results

The sample contains 40 one-point games and eight three-point games against
the previous PR head, all at 600 ms per move and maximum main depth ten. The
one-point sample consists of 20 Long Pro book games (seed 71001, book width 50)
and 20 Long Pro games with three seeded legal opening plies (seed 75001).
The three-point book suite uses seed 79001 and width 50. One-point games have
an 80-ply cap; three-point games have a 120-ply cap. All use threefold repetition
and the application's legal fallback policy.

Each opening is played with colors swapped. `--unique-openings` skips duplicate
exact board states between pairs, with a bounded search and an error on
exhaustion. `--fresh-engines --bundle` runs every game in a new worker, releasing
both engines before starting the next game. This resets all module state,
including the tactical prover's root cache, rather than only TT/history.
The harness tests deterministic pair generation, exhaustion and state isolation
for both engines.

| Opening set | Target | Games | Exact starting boards | Wins | Losses | Draws |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Long Pro book | 1 | 20 | 10 | 10 | 10 | 0 |
| Long Pro, three seeded plies | 1 | 20 | 10 | 9 | 11 | 0 |
| Long Pro book, three points | 3 | 8 | 4 | 3 | 5 | 0 |

The one-point total is **19 wins and 21 losses**; three-point play scores
**3 wins and 5 losses**. No game needed a legal move replacement or ended in an
illegal-move forfeit. These results do **not** establish an Elo gain. The retained
change reduces measured search cost while preserving fixed-work search results.

The three suites contain respectively 6, 10 and 4 distinct boards after
accounting for rotations and reflections. Current-engine Black/White wins are
3/7, 3/6 and 1/2. Opening bias, rotational equivalence and color pairing limit
the independent evidence in this sample.

Unique exact boards can still be equivalent under rotation or reflection, and
the heuristic opening book is not a balanced tournament book. Color-swapped
games share an opening. These are limited Node engine observations; they do
not certify general Elo or browser playing strength. Browser scheduling,
pondering and Ultra worker coordination were not benchmarked.

## Verification and reproduction

All **45 automated tests and 14 tactical puzzles** pass. Type checking reports
zero errors and warnings; the production build and whitespace check pass.
New regressions cover root reuse and score-hash restoration, parent scans with
mutated board cells, full/local winning-square order, and blocking masks over
260 varied boards. An additional development comparison matched 16,000 ordered
scanner results against the previous head over 2,000 random boards, both colors,
both Ko modes and full/local queries.

Raw measurements, game traces, initial boards and source SHA-256 hashes are in
[ai-strength-round4-results.json](ai-strength-round4-results.json). Earlier
experiments remain in [round 3](ai-strength-round3.md) and
[the initial follow-up](ai-strength-followup.md).

Run timed commands serially without competing tests or benchmarks:

```sh
git worktree add --detach ../grr-pr2-base d50a97e7efca1ea313523af88e4c03160594d914
node --import tsx --test --test-isolation=none scripts/*.test.mjs
node --import tsx scripts/run_puzzles.ts --time 250 --json
node scripts/compare_search.mjs --reference ../grr-pr2-base --rounds 9
node scripts/bench_ai.mjs --root ../grr-pr2-base --benchIters 5 --benchTimeMs 400 --time 100 --json
node scripts/bench_ai.mjs --benchIters 5 --benchTimeMs 400 --time 100 --json
node node_modules/@sveltejs/kit/svelte-kit.js sync
node node_modules/svelte-check/bin/svelte-check --tsconfig ./tsconfig.json
node node_modules/vite/bin/vite.js build

node --import tsx scripts/compare_ai.mjs --reference ../grr-pr2-base --bundle --games 20 --time 600 --opening long-pro-book --book-width 50 --target 1 --seed 71001 --illegal fallback --unique-openings --fresh-engines --trace /tmp/round4-book
node --import tsx scripts/compare_ai.mjs --reference ../grr-pr2-base --bundle --games 20 --time 600 --opening long-pro --target 1 --seed 75001 --illegal fallback --unique-openings --fresh-engines --trace /tmp/round4-varied
node --import tsx scripts/compare_ai.mjs --reference ../grr-pr2-base --bundle --games 8 --time 600 --opening long-pro-book --book-width 50 --target 3 --seed 79001 --plies 120 --illegal fallback --unique-openings --fresh-engines --trace /tmp/round4-multipoint
```
