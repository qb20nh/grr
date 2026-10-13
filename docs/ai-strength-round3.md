# Tactical safety and search allocation

This round compares with `01e8a226317dbac8d69ec1331de9e9cbb4b167ab`, the
previous head of PR #2. Tests use bundled Node v24.19.0. The application still
uses handcrafted evaluation; no trained NNUE weights were activated.

## Changes

Two tactical failures were reproduced before their fixes. A root search could
report a selective loss at its maximum depth without checking omitted candidates.
It now retries the entire generated root list at the same depth, including in
pondering sessions. Restricted-root transposition bounds use a separate key so
they cannot cut off the wider retry or an interior search. This widens the
existing generated candidate set; it does not enumerate every legal quiet move.

At the tactical horizon, a position with no legal reply to an immediate
match-ending threat previously received a static score. It now receives the
correct next-move loss score. The existence query stops at the first legal defense
without scoring or sorting all possible replies. Complete defensive enumeration
remains in use where the search needs every reply. Multi-point replies still
account for scores, exact-five intersections, Ko and stone clearing.

Quiescence results have their own bounded cache, separate from the main depth
table. Entries include exact/lower/upper bounds and normalized mate distances.
Reuse requires the same remaining tactical depth and position, including Ko,
side to move and match scores. Aborted searches are not cached. A pondering
session retains the cache only for its current position.

The tactical prover now shares the complete immediate-defense generator instead
of maintaining a second defense implementation. Live one-point searches permit
225 defender replies, enough for all legal fillers and safe rifts. An incomplete
or timed-out defender search cannot establish a proven win. Cache keys retain
full limit values rather than truncating them to six bits.

Pattern-only callers use an allocation-free category scanner. Coordinate-dependent
callers retain the full `LineInfo` scanner. Both use the same category ranking,
including single-gap patterns, exact fives and overline rejection.

One-point play reduces the bounded quiescence continuation from four plies
to two. The loss traces often showed only zero or one completed main-search ply;
reserving time for the main search lets it inspect more nonforcing alternatives.
The exact immediate-win and no-defense checks still run at the tactical boundary.
This is a measured search-allocation tradeoff, not an assertion that shorter
quiescence is universally stronger. An initial attempt to apply two plies to all
targets scored 1-3 in the four-game multi-point validation. The final version
retains the existing four-ply ceiling for multi-point and unlimited play, which
skip the tactical prover. Additional multi-point checks are recorded below.

## Development experiments

Each row used eight games against the previous version, colors swapped, 600 ms
per move, one-point games, Long Pro book width 50, seed 47001. These reused
positions guided development and are not a validation sample.

| Candidate | Wins | Losses | Decision |
| --- | ---: | ---: | --- |
| Quiescence cache | 3 | 5 | Continue with other changes |
| Add complete tactical-prover defenses | 4 | 4 | Continue |
| Add same-depth root widening | 4 | 4 | Keep reproduced correctness fix |
| Symmetric evaluation weights | 3 | 5 | Reject |
| Horizon loss check plus extra forced continuations | 3 | 5 | Reject extra continuations |
| Add pattern-only scan to that extension candidate | 4 | 4 | Retain scanner, remove extensions |
| Horizon existence check without extra continuations | 4 | 4 | Continue |
| Two-ply quiescence | 5 | 3 | Freeze initial candidate for validation |

The extra-continuation candidate spent too much time in the tactical frontier;
its dense benchmark failed to complete even depth one. The symmetric evaluator
did not provide evidence of a strength benefit and was restored. Neither rejected
change is present in the final engine. The raw results preserve all 64 development
games and their source stages.

## Performance

Four unchanged fixtures, fresh TT and ordering state per repetition, warmup,
five measured repetitions at 400 ms, maximum main depth 10:

| Position | Previous nodes/s | Final nodes/s | Previous main depth | Final main depth |
| --- | ---: | ---: | ---: | ---: |
| Opening center cluster | 19,201 | 17,684 | 1.0 | 4.0 |
| Tactical fork position | 24,857 | 21,840 | 3.0 | 5.0 |
| Ko edge defense | 16,270 | 17,039 | 1.0 | 3.0 |
| Dense midgame | 43,676 | 24,561 | 1.0 | 3.0 |
| Aggregate | 26,001 | 20,281 | | |

The final engine completes more main-search plies, but these depth figures exclude
quiescence and therefore are not equivalent total search horizons. Aggregate
nodes/s decreases by 22.0%; no overall throughput gain is claimed for this round.
Different node types and tactical work also make nodes/s insufficient to establish
playing strength. The isolated cache candidate measured 27,171 nodes/s, but that
number is not the final engine's throughput.

An alternating seven-round microbenchmark of 210,160 pattern queries per round
measured a median 9.39 ms for full scan plus classification and 7.03 ms for the
category-only path, about 25% less time in that routine. This is an isolated
routine measurement, not a whole-engine multiplier. All query-result counts agreed.

## Verification

- 35 automated tests pass, including both reproduced tactical failures.
- All 14 tactical puzzles pass at 250 ms, and at 100 ms in the bundled benchmark.
- Pattern categories match the independent run-based oracle over every ternary
  nine-cell line; additional full-board cases cover both colors, every direction,
  edges, longer runs and both Ko modes.
- A recorded three-point position reproduces the missed five-ply forcing win
  with the two-ply frontier and verifies the retained four-ply search. A second
  replay diagnostic shows the same failure pattern.
- First-defense queries are checked against exhaustive legal-defense sets,
  including the existing multi-point scoring-and-clearing oracle.
- A bundled cache-on/cache-off comparison agrees on all eight full-window
  fixed-depth values, covering one- and three-point targets and a mate-distance
  result. It exercised 398 cache hits and checked complete board restoration.
- Type checking reports zero errors and warnings. The production build and
  whitespace check pass. Browser end-to-end behavior remains untested.

## Validation matches

The initial two-ply candidate was frozen before these suites. Counts and seeds
were fixed in advance: 20 games against the previous version (seed 52001), 20 against the
original engine (seed 56001), four three-point games against the previous version
(seed 59001), and two full-opening games at five seconds per move (seed 101).
All use paired colors, fresh main TT and ordering state per game, the same nominal time limit,
maximum depth 10, and legal fallback mode. Book width is 50. Single-point games
allow 80 plies and three-point games allow 120. The small TSS root cache persists
within each engine across games in a suite; these are not completely cold-engine
games, and repeated positions can benefit from that cache.

The initial multi-point result led to restricting the two-ply setting to
one-point play. The 42 one-point games precede that restriction; their search
logic is unchanged. Source hashes distinguish both stages. Multi-point play is
checked again on the four previously used games and four new-seed games
(seed 63001). The reused games are development results, not a new validation sample.

| Opponent | Opening | Time/move (ms) | Target | Wins | Losses | Draws |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Previous version | Long Pro book, seed 52001 | 600 | 1 | 12 | 8 | 0 |
| Original engine | Long Pro book, seed 56001 | 600 | 1 | 16 | 4 | 0 |
| Previous version | Full Long Pro, fixed center start | 5,000 | 1 | 1 | 1 | 0 |
| Previous version | Long Pro book, seed 63001, scoped final | 600 | 3 | 2 | 2 | 0 |

The previous-version book suite has 8 distinct boards;
Black and White each scored 6/10. The original-engine suite has
9 distinct boards; Black scored 6/10 and White 10/10.
The original needed six legal move repairs, and the candidate needed none.
No final suite had an illegal-move forfeit. The full-opening suite and final
multi-point suite needed no repairs. The latter contains
2 distinct initial boards.

The rejected all-target two-ply candidate scored 1-3 in multi-point play. After
restoring the multi-point frontier, the same four development games also scored
1-3; the new-seed suite above scored
2-2. The replay regression supports the
correctness fix, but these small suites do not establish a multi-point strength
gain. All 118 games across fourteen suites are retained; different candidates and
conditions must not be pooled into one win rate.


These finite, time-limited games cannot establish a general Elo gain or a
near-100% win guarantee. Seeds may repeat opening boards or overlap development
boards. Full Long Pro has one fixed center-stone start and tests the engines'
opening choices rather than providing opening diversity. Browser worker scheduling,
pondering and Ultra coordination have not been timed. Future work still includes
broader tactical coverage, opening diversity, and trained evaluation; this round
does not exhaust possible improvements.

All measurements, initial boards and final source hashes are in
[ai-strength-round3-results.json](ai-strength-round3-results.json). Earlier-stage
results remain in [the previous follow-up](ai-strength-followup.md); they should
not be attributed to this final candidate.

## Reproduce

```sh
node --import tsx --test scripts/*.test.mjs
node --import tsx scripts/run_puzzles.ts --time 250
node scripts/bench_ai.mjs --root ../grr-before-round3 --benchIters 5 --benchTimeMs 400 --time 100
node scripts/bench_ai.mjs --benchIters 5 --benchTimeMs 400 --time 100
node node_modules/@sveltejs/kit/svelte-kit.js sync
node node_modules/svelte-check/bin/svelte-check --tsconfig ./tsconfig.json
node node_modules/vite/bin/vite.js build

node --import tsx scripts/compare_ai.mjs --reference ../grr-before-round3 --bundle --games 20 --time 600 --opening long-pro-book --book-width 50 --target 1 --seed 52001 --illegal fallback
node --import tsx scripts/compare_ai.mjs --reference ../grr-baseline --bundle --games 20 --time 600 --opening long-pro-book --book-width 50 --target 1 --seed 56001 --illegal fallback
node --import tsx scripts/compare_ai.mjs --reference ../grr-before-round3 --bundle --games 4 --time 600 --opening long-pro-book --book-width 50 --target 3 --seed 63001 --plies 120 --illegal fallback
node --import tsx scripts/compare_ai.mjs --reference ../grr-before-round3 --bundle --games 2 --time 5000 --opening long-pro-full --target 1 --seed 101 --illegal fallback
```

`../grr-before-round3` must contain the previous commit identified above.
`../grr-baseline` must contain the original engine
`e25e99bb3285c34c0c8dc885f0e2a0aae674a752`. Run timed suites serially without
competing benchmarks or test processes.
