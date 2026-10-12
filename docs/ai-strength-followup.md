# AI search follow-up

This continues the work in `fdbbfddefb2771894c68d2f19a9ece9f637add70`, merged by
PR #1 as `d8695812b6a407086ada0bcba8bef929b4a5428c` (identical source tree).
Measurements use bundled Node v24.19.0 on 2026-10-12 UTC / 2026-10-13 Korea time.
The application still uses handcrafted evaluation, with no active NNUE weights.

## Changes

Profiling replayed losses found repeated line scans and winning-square queries
dominating execution time. This update shares precomputed line geometry with the
winning-square scanner, filters impossible fork directions before detailed scans,
and checks only the lines changed by a candidate move when identifying forcing
attacks. Previously existing threats are rechecked, including threats affected by
Ko expiration or an overline. The complete immediate-defense set is preserved.

Quiescence no longer computes an unused static fork evaluation at forced-defense
nodes. Root safety
uses the exact winning-square query on match point when no opening filter applies,
instead of generating and applying every opponent candidate.

The fork evaluation now scores the strongest compatible pair of potential
fork-producing placements, or one such placement, instead of summing every
alternative square. This reduces overcounting of mutually exclusive attack plans.
Existing patterns and terminal-score clamping are still evaluated separately.

An interrupted first iteration retains the best fully searched root child instead
of reverting to the original heuristic choice. The aborted child is discarded,
and the result still reports completed depth zero. A completed earlier iteration
remains authoritative; repeated pondering slices retain the stronger completed
child from earlier slices of the same position.

Two findings on the merged PR were reproduced and fixed during this follow-up.
Multi-point search now recognizes wins from intersecting exact-five lines and
compatible scoring pairs, including at the quiescence horizon. Mandatory defense
generation checks the actual points needed and all opposing winning placements.
Rift defenses account for points and stone clearing caused by the capture. When
the defender has a nonterminal scoring counterplay, ordinary match search still
handles the clearing and its effect on pair legality.

The comparison script now records every illegal move category as a forfeit in
`--illegal forfeit` mode, instead of aborting on null moves, invalid pairs/rifts
or opening violations. Strength matches continue to use legal fallback mode.

## Search performance

Same four positions, fresh TT/history for each repetition, warmup before timing,
400 ms per position, maximum depth 10, five measured repetitions:

| Position | Previous nodes/s | Updated nodes/s | Previous completed depth | Updated completed depth |
| --- | ---: | ---: | ---: | ---: |
| Opening center cluster | 13,558 | 19,501 | 1.0 | 1.0 |
| Tactical fork position | 19,429 | 26,089 | 3.0 | 3.0 |
| Ko edge defense | 9,960 | 16,045 | 1.0 | 1.0 |
| Dense midgame | 24,987 | 45,261 | 1.0 | 1.0 |
| Aggregate | 16,983 | 26,724 | | |

Aggregate throughput increased by 57.4%. Completed depth was unchanged on these
four fixed benchmarks. This is a bundled Node search workload,
not an Elo or browser-latency multiplier. Ordering changes can reduce node counts
while improving completed depth, so nodes/s alone was not used to select changes.

## Validation method

- The winning-square scan remains checked against brute-force exact-five placement.
- Local post-move threat detection is compared with a full-board scan across
  seeded boards, both colors, Ko, placements, scoring singles and rifts.
- The fork prefilter is compared with exhaustive empty-square pattern analysis.
  A separate 2,000-board check also matched the previous ordered winning-square
  and fork lists exactly, for both colors and both Ko modes.
- A deterministic interruption test reproduces the lost fully searched candidate
  in the previous version and verifies first-iteration, completed-iteration and
  repeated-slice behavior, including board restoration and honest depth metadata.
- Multi-point fixtures reproduced both missing horizon wins and missing forced
  defenses before the fix. Winning singles and pairs are checked against actual
  scoring and clearing on fixed and seeded boards, with Ko and overlines. A
  two-line threat's complete defense set is compared with every legal reply.
- The actual comparison CLI is run against deliberately illegal reference engines
  to verify six null, pair, rift, single-placement and opening-violation cases.
- Existing worker, shared-TT, opening, scoring, pattern and optional NNUE tests
  remain part of the gate. Browser end-to-end execution is still untested.

Final checks: 32/32 automated tests, 14/14 tactical puzzles at 250 ms, zero type
errors/warnings, and a successful production build. One earlier build encountered
an ENOENT in a generated `.rsync-tmp` path; an unchanged-source retry and both
subsequent final-candidate builds succeeded.

Development matches used eight color-swapped Long Pro games per variant, 600 ms
per move, seed 17001, against the previous published version. Geometry/forced-node
evaluation/fork filtering scored 5-3; adding local attack checks and partial-root
recovery scored 3-5; limiting hypothetical fork bonuses to a legal pair scored
4-4; adding quiescence history ordering to the uncapped evaluation scored 4-4.
These are development observations on reused starts, not independent validation.

The quiescence-ordering candidate then scored 14-6 against the previous version
with the narrow opening pool, and 20-0 against the original engine. However, a
20-game wider-opening comparison against the previous version scored only 7-13.
It was rejected: the favorable 20-0 result is **not a final-version result**.
Two further eight-game tests on the same wide-opening starts scored 4-4 without
quiescence ordering and 5-3 after limiting alternative fork plans.

The fork evaluation change intentionally alters the raw score of an old overflow
fixture. That position now stays below the static score limit without clamping.
The regression suite additionally uses sixteen simultaneous real fours to retain
the independent check that excessive raw pattern scores are clamped below the
terminal range. No terminal-score safeguard was removed.

## Match results

Paired colors, bundled engines, fresh TT/history per game, maximum depth 10,
same nominal time limit, and legal fallback replacements. Long Pro book tests
use `--book-width 50`: the reference-ranked pool for White's first pair is wider
than the earlier default of 12. Engines choose Black's restricted second move.

| Opponent | Opening | Time/move | Target | Games | Wins | Losses | Draws |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Previous published version | Long Pro book, seed 37001 | 600 ms | 1 | 20 | 12 | 8 | 0 |
| Original engine | Long Pro book, seed 41001 | 600 ms | 1 | 20 | 13 | 7 | 0 |
| Previous published version | Full Long Pro, forced center only | 5,000 ms | 1 | 2 | 1 | 1 | 0 |
| Previous published version | Long Pro book, seed 43001, after multi-point fix | 600 ms | 3 | 4 | 3 | 1 | 0 |

These 42 one-point games were recorded before the later multi-point review fix;
their one-point search logic is unchanged. Both source stages are identified in
the results JSON. The final multi-point comparison uses two distinct starts and
needed no move repairs. Before the scoring fix, the same four-game development
suite scored 4-0. The fix is supported by reproduced correctness failures and
exhaustive defense checks; these small, time-sensitive matches do not establish
that it increased the multi-point win rate.

Both 20-game book suites contain nine distinct initial boards. Against the
previous version, Black scored 5/10 and White 7/10, with no repairs. Against the
original, Black scored 7/10 and White 6/10. That suite needed 23 reference repairs and
zero candidate repairs. There were no illegal-move forfeits. Full Long Pro has
one fixed start, tested with both colors, so it supplies no opening diversity.

Seeds can duplicate boards and overlap development positions. These observations
do not establish a general win rate, balanced opening book, Elo gain or near-100%
guarantee. The engine remains selective and uses handcrafted evaluation.
Real-browser worker scheduling, pondering and Ultra coordination were not timed.
All development variants and the rejected wider-opening regression are retained
in [ai-strength-followup-results.json](ai-strength-followup-results.json).
The record contains 158 games across fourteen development and validation suites;
different variants and conditions must not be pooled into one win rate.

## Reproduce

```sh
node --import tsx --test scripts/*.test.mjs
node --import tsx scripts/run_puzzles.ts --time 250
node scripts/bench_ai.mjs --root ../grr-before-next --benchIters 5 --benchTimeMs 400 --time 100
node scripts/bench_ai.mjs --benchIters 5 --benchTimeMs 400 --time 100
node node_modules/@sveltejs/kit/svelte-kit.js sync
node node_modules/svelte-check/bin/svelte-check --tsconfig ./tsconfig.json
node node_modules/vite/bin/vite.js build

node --import tsx scripts/compare_ai.mjs --reference ../grr-before-next --bundle --games 20 --time 600 --opening long-pro-book --book-width 50 --target 1 --seed 37001 --illegal fallback
node --import tsx scripts/compare_ai.mjs --reference ../grr-baseline --bundle --games 20 --time 600 --opening long-pro-book --book-width 50 --target 1 --seed 41001 --illegal fallback
node --import tsx scripts/compare_ai.mjs --reference ../grr-before-next --bundle --games 2 --time 5000 --opening long-pro-full --target 1 --seed 101 --illegal fallback
node --import tsx scripts/compare_ai.mjs --reference ../grr-before-next --bundle --games 4 --time 600 --opening long-pro-book --book-width 50 --target 3 --seed 43001 --plies 120 --illegal fallback
```

`../grr-before-next` must contain the previous published commit above.
`../grr-baseline` must contain the original engine
`e25e99bb3285c34c0c8dc885f0e2a0aae674a752`; historical results are in
[ai-strength-validation.md](ai-strength-validation.md).
