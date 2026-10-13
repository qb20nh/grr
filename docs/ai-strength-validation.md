# AI strength validation

Archived measurements for `fdbbfddefb2771894c68d2f19a9ece9f637add70`.
See [the follow-up](ai-strength-followup.md) for subsequent changes and measurements.

Measured on 2026-10-12 UTC with Node v24.19.0. Reference engine:
`e25e99bb3285c34c0c8dc885f0e2a0aae674a752` (the original main branch).
The application still uses handcrafted evaluation; no trained NNUE model is
enabled. Machine-readable observations and source hashes are in
[ai-strength-results.json](ai-strength-results.json).

## Results

Long Pro is the primary comparison. Both engines receive the application's
opening restrictions, including restrictions on their next two search plies.
Black's forced center stone is placed before play. Colors are swapped for each
start, with fresh TT/history per game. Both engines are bundled and use the same
nominal time budget and a maximum depth of 10. Timing may vary between runs.

| Start / purpose | Time per move | Target | Games | Current wins | Reference wins | Draws |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Long Pro: seeded White first pair; engines choose restricted Black second move | 600 ms | 1 | 20 | 13 | 7 | 0 |
| Long Pro: engines choose every move after forced center | 5,000 ms | 1 | 2 | 2 | 0 | 0 |
| Additional Long Pro positions: first three plies preplaced | 600 ms | 1 | 20 | 8 | 12 | 0 |
| Additional Long Pro positions: first three plies preplaced | 5,000 ms | 1 | 4 | 1 | 3 | 0 |
| Additional standard-rule quiet positions: six plies preplaced | 600 ms | 1 | 20 | 18 | 2 | 0 |
| Additional standard-rule quiet positions: scoring and stone clearing | 600 ms | 3 | 4 | 2 | 2 | 0 |

The primary 20-game suite scored 65%, with 4/10 wins as Black and 9/10 as
White. Its 10 seeded opening pairs contained **7 distinct starting boards**;
they are not 20 independent samples or certified balanced positions. The two
full-opening games share one initial position and establish only that this
version won that timed color-swapped pair. They do not establish a 100% win rate.
The auxiliary quiet suite's 90% must not be treated as the general win rate.
The losing additional Long Pro suites remain part of the record.

All 70 games used legal replacement moves instead of awarding illegal-move
forfeits. In the primary 20-game suite the current engine needed zero replacements
and the reference needed nine; neither engine needed replacements in the two
full-opening games. The first two auxiliary suites recorded total replacements
but did not split that count by engine. Games use a threefold-repetition draw
and an 80-ply cap (120 for the three-point suite).

These are Node engine matches, without browser scheduling, pondering, or Ultra
worker coordination. The worker protocol was tested separately under Node;
browser end-to-end testing was unavailable because Chromium installation failed.
There is no supported Elo estimate, near-100% guarantee, or claim that all
possible improvements have been exhausted.

## Changes supported by the investigation

- A replayed loss exposed four legal Ko defensive rifts ranked below heuristic
  candidate limits. Immediate match-ending threats now enumerate every legal
  blocking filler and every safe rift before those limits. An exhaustive legal
  move oracle verifies the response set on five positions, including intersecting
  fours and overlines.
- Quiescence identifies real forcing attacks by applying moves. It retains
  generated forcing rifts, does not mistake an open-three/gap-three combination
  for a quiet position, and does not use ordering bonuses as pruning bounds.
- Root widening preserves generated rifts and complete immediate defenses.
  TSS spends its attacker quota only on moves that create actual forcing threats.
- The worker keeps playing legal moves instead of resigning from a selective
  loss score, which cannot establish that every legal defense loses.
- Long Pro opening fallback generation caches single-placement evaluations
  while enumerating legal pairs. It preserves pair scores and avoids repeating
  the same evaluation thousands of times for Black's restricted second move.

Earlier changes in this branch also correct exact-five/gap pattern detection,
bound heuristic values below terminal scores, fix PVS tie handling and root
fallback metadata, isolate opening-filtered TT scores, make shared-TT publication
atomic, and correct optional NNUE scoring/undo state. Current workers still pass
null NNUE weights.

The primary book suite's fixed move-generation workload produced identical
outputs and median times of 22.21 ms versus 217.81 ms for 400 calls across five
rounds (9.81x). This is a component benchmark, not a search-speed or playing-strength
multiplier. More complete tactical search does more work per node, so the older
branch's 12.7x search-throughput result is not a current-version claim.

Rejected experiments included quiescence depth six (delayed completed iterations
in tactical positions), removing fork bonuses (no observed match improvement),
and an extra quiescence TT cache (no completed-depth gain and lower aggregate
throughput in the isolated benchmark). They are not enabled in the final code.

## Reproduce

Create a separate reference checkout at the commit above with dependencies
available, then run these commands from the candidate checkout:

```sh
node --import tsx --test scripts/*.test.mjs
node --import tsx scripts/run_puzzles.ts --time 250
node node_modules/@sveltejs/kit/svelte-kit.js sync
node node_modules/svelte-check/bin/svelte-check --tsconfig ./tsconfig.json
node node_modules/vite/bin/vite.js build

node --import tsx scripts/compare_ai.mjs --reference ../grr-baseline --bundle --games 20 --time 600 --opening long-pro-book --illegal fallback --seed 14001 --trace /tmp/grr-longpro-book
node --import tsx scripts/compare_ai.mjs --reference ../grr-baseline --bundle --games 2 --time 5000 --opening long-pro-full --illegal fallback --seed 101 --trace /tmp/grr-longpro-full

node --import tsx scripts/compare_ai.mjs --reference ../grr-baseline --bundle --games 20 --time 600 --opening long-pro --illegal fallback --seed 4099
node --import tsx scripts/compare_ai.mjs --reference ../grr-baseline --bundle --games 4 --time 5000 --opening long-pro --illegal fallback --seed 9001
node --import tsx scripts/compare_ai.mjs --reference ../grr-baseline --bundle --games 20 --time 600 --opening quiet --illegal fallback --seed 2027
node --import tsx scripts/compare_ai.mjs --reference ../grr-baseline --bundle --games 4 --time 600 --opening quiet --illegal fallback --seed 11001 --target 3 --plies 120
```

Final verification: **24/24 tests, 14/14 tactical puzzles, zero type-check errors
or warnings, and a successful production build**. Tests cover application-worker
opening legality, scoring, Ko and continued play in a losing position as well as
the engine-level invariants. Run timed matches without competing CPU workloads.

The four auxiliary suites preceded the final opening-only scorer optimization;
their searches start after opening restrictions expire. The two primary suites
and final tests exercised the final engine source. The stored source hashes allow
the measured engine snapshot to be identified independently of later doc edits.
