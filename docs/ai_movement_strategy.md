## AI movement strategy (technical overview)

This document describes how Gomoku Rift’s AI chooses moves (reinforce / rift, with a single-stone win as a special-case reinforce), how it narrows the move set, evaluates positions, and searches efficiently.

**Runtime status:** the application workers explicitly pass null NNUE weights.
Live play uses the handcrafted evaluator. NNUE sections describe optional engine
and offline training code, not an enabled or trained application model.

---

### System-level dataflow

```mermaid
sequenceDiagram
  participant UI as UI_Svelte
  participant Engine as Engine_TS
  participant Worker as AIWorker_TS
  participant Search as Search_TS

  UI->>Engine: HumanMove
  Engine->>Worker: ponderStart_or_positionUpdate
  Engine->>Worker: findBestMove
  Worker->>Search: findBestMove_or_searchSlice(board,toMove,time,maxDepth,nnueWeights?)
  Search-->>Worker: result(move,score,depth,nodes)
  Worker-->>Engine: result(move,stats,ponderReport,ttStats)
  Engine->>Engine: validateAndApplyMove
  Engine-->>UI: renderMove
```

Key entrypoints:
- `src/lib/game/engine.ts`: owns worker lifecycle (one worker per color in `ai-vs-ai`), manages pondering (`ponderStart`/`positionUpdate`/`ponderStop`), sends `findBestMove`, validates worker results, applies moves.
- `src/lib/game/ai.worker.ts`: converts UI state into internal `Board`, uses handcrafted evaluation, manages time allocation + pondering sessions, then calls into search (`findBestMove` or `SearchSession.searchSlice` on ponder hit).
- `src/lib/game/ai/search.ts`: top-level move selection policy + iterative deepening alpha-beta (PVS) + quiescence + root safety.

---

### Core rule model (what a “move” is)

```mermaid
flowchart TD
  turnStart["TurnStart"] --> chooseAction{"Choose_action"}

  chooseAction -->|reinforce| reinforce["Reinforce(place_1_or_2_stones)"]
  chooseAction -->|rift| rift["Rift(remove_opponent_stone)"]

  reinforce --> stones{"Stones_placed?"}
  stones -->|"1"| singleWin["Reinforce_single_stone(only_if_immediate_win)"]
  stones -->|"2"| twoStone["Reinforce_two_stones"]

  twoStone --> colinear{"Colinear?"}
  colinear -->|no| reinforceOk["Legal"]
  colinear -->|yes| shield{"Shield_exception(opponent_between)?"}
  shield -->|yes| reinforceOk
  shield -->|no| reinforceBad["Illegal"]

  rift --> ko["Set_Ko_to_rifted_cell"]
  ko --> riftOk["Legal_if_target_is_opponent"]

  reinforceOk --> exact5["Win_rule_exact5_only"]
  riftOk --> exact5
  singleWin --> exact5
```

Implementation anchors:
- `src/lib/game/ai/types.ts`: `ActionType = 'reinforce' | 'rift'`; `Move = ReinforceMove | SingleWinMove | RiftMove` (note: `SingleWinMove.action` is still `'reinforce'`, with `pos2: null`).
- `src/lib/game/ai/board.ts`: legality (`validateReinforce`, `validateRift`, `checkColinearityConstraint`), application (`makeMove`/`unmakeMove`), exact-5 win checks (`checkWinAt`, `getWinnerAfterMove`).
  - Rift nuance: a `rift` can immediately create an exact-5 win for the *removed* color (by trimming an overline down to 5), so root move safety must guard against self-losing rifts.

---

### Board & hashing (what search operates on)

```mermaid
flowchart LR
  board["Board{cells,blackCount,whiteCount,hash,koPosition}"] --> zob["zobrist:updateHash_or_updateKoHash"]
  zob --> posHash["PositionHash(BigInt)"]
  posHash --> ttKey["TTKey=withTurn(hash,toMove)"]
```

- Board is a packed `Uint8Array(225)` plus counters + `koPosition`.
- Hash includes stones + Ko; TT key xors side-to-move.
- The TT itself is a typed-array, 2-way set-associative table keyed by `withTurn(board.hash, player)`.
- Files: `src/lib/game/ai/board.ts`, `src/lib/game/ai/zobrist.ts`, `src/lib/game/ai/transposition.ts`.

---

### Candidate selection: “near existing stones”, then “best scored first”

```mermaid
flowchart TD
  start["generateAllMoves"] --> reinforce["generateReinforceMoves"]
  start --> rift["generateRiftMoves"]

  reinforce --> neigh["CandidateSquares(radius=CONFIG.CANDIDATE_RADIUS)"]
  neigh --> score["ScoreEachSquare(evaluateSinglePosition)"]
  score --> pair["Generate_pairs(checkColinearityConstraint)"]
  pair --> outR["Reinforce_moves(sorted,capped)"]

  rift --> outF["Rift_moves(sorted,capped)"]

  outR --> merge["Merge_sorted_lists"]
  outF --> merge
  merge --> out["ScoredMove_list_for_search"]
```

Notes:
- Immediate match wins and complete immediate defenses are generated before heuristic candidate caps. A forced single-square block includes every legal second stone; every legal rift target is checked against the resulting exact-five threats and Ko. Ordinary candidate limits apply when no such forced response exists.
- The radius filter is a *branching-factor control*. It is not strictly “closest-first”; the ordering is by heuristic score.
- Config knobs live in `src/lib/game/ai/constants.ts` (under `CONFIG`: `CONFIG.CANDIDATE_RADIUS`, `CONFIG.MAX_CANDIDATES`, `CONFIG.MAX_PAIRS`, `CONFIG.MAX_RIFTS`).
- Reinforce pairing uses a smaller “top slice” for combinatorics (`topCandidates = scoredCandidates.slice(0, 25)`), then caps final unique pairs with `CONFIG.MAX_PAIRS`.
- File: `src/lib/game/ai/moveGen.ts` (`getCandidatePositions`, `scoreCandidates`, `generateReinforceMoves`, `generateRiftMoves`, `generateAllMoves`).

---

### “Must-block” logic (tactical priority)

```mermaid
flowchart TD
  pos["Position"] --> oppWins["OpponentWinningSquares(ignoreKo=true)"]
  oppWins --> mustBlock{"Any_winning_square?"}
  mustBlock -->|yes| forceBlocks["Generate_pairs_including_critical_blocks"]
  mustBlock -->|no| normal["Normal_pairing_from_top_candidates"]
```

- “Opponent winning squares” come from `findWinningPositionsAssumingKoClears` (Ko ignored because it will clear on the opponent’s next ply): `src/lib/game/ai/threats.ts`.
- Critical blocks are assembled from:
  - a scratch “blocking mask” (`getBlockingMask`) derived from opponent threat patterns (notably `OPEN_FOUR`, `HALF_FOUR`, `GAP_FOUR`, `OPEN_THREE`)
  - plus any direct opponent win squares (Ko-clearing) that are currently legal placements.
- This influences both reinforce move generation (huge bonuses / enumeration of blocking pairs) and rift scoring (defensive rifts get a large bonus if they reduce opponent win squares).
- Before those heuristic lists are used, `generateImmediateResponses` enumerates complete defenses to immediate match-ending threats. Reinforce must cover every winning square; rifts must eliminate every legal winning reply without awarding an exact-five to the opponent. This complete set bypasses tactical and root top-K limits. Nonterminal scoring remains in the full match search because it clears stones.

---

### Pattern/threat pipeline (how “winning squares” are detected)

```mermaid
flowchart TD
  stone["Stone_at_pos"] --> scan["scanLine(pos,dir)"]
  scan --> classify["classifyLine(LineInfo)"]
  classify -->|OPEN_FOUR_or_HALF_FOUR| ext["ExtendSquares_as_win_squares"]
  classify -->|GAP_FOUR| gap["GapSquare_as_win_square"]
  classify -->|OPEN_THREE_or_FOUR| blocks["BlockingMask_marks_extend_or_gap"]
```

Files:
- `src/lib/game/ai/patterns.ts`: `scanLine`, `classifyLine`, `countPatterns`.
- `src/lib/game/ai/threats.ts`: `getSingleStoneWinningSquares` / `findWinningPositions*`, `getBlockingMask`, threat levels/forks.
  - Note: these APIs accept a Ko mode (`respectKo` vs `ignoreKo`) to model “Ko clears next ply” when needed.

---

### Evaluation stack (handcrafted + optional NNUE)

```mermaid
flowchart TD
  eval["evaluateSearch(board,player,nnueState?)"] --> hasNnue{"NNUE_available?"}
  hasNnue -->|yes| nnue["NNUE_incremental_eval"]
  hasNnue -->|no| handcrafted["Handcrafted_eval"]
  nnue --> score["EngineScore"]
  handcrafted --> score
```

Handcrafted eval (high level):
- patterns (exact-5 aware), threat levels, fork bonuses, center/connectivity terms.
- File: `src/lib/game/ai/evaluate.ts`.

NNUE (high level):
- 1-layer accumulator: add/remove features on moves; eval is `tanh(dot(relu(hidden),outW)+bias+phase+stm)`.
- Search maps NNUE’s value in `[-1,1]` into the engine score domain via `CONFIG.NNUE_VALUE_SCALE`, and falls back to handcrafted eval if NNUE returns a non-finite value.
- Files: `src/lib/game/ai/nnue/evaluator.ts`, `src/lib/game/ai/nnue/weights.ts`.

---

### Search: top-level decision policy

```mermaid
flowchart TD
  root["findBestMove"] --> quickWin{"Immediate_win_exists?"}
  quickWin -->|yes| playWin["Play_immediate_win"]
  quickWin -->|no| tssA["ThreatSpaceSearch_attack"]
  tssA -->|proven_win| playTss["Play_proven_forcing_line"]
  tssA -->|no_proof| threat{"Under_immediate_threat?"}
  threat -->|yes| tssD["ThreatSpaceSearch_defense"]
  tssD --> hint["rootMoveHint(defensive_refutation_if_found)"]
  hint --> deepDef["IterativeDeepening_alpha_beta(with_hint)"]
  threat -->|no| deep["IterativeDeepening_alpha_beta"]
  deep --> safe["sanitizeRootMove(avoid_immediate_loss)"]
  deepDef --> safe
  safe --> out["BestMove"]
```

Notes:
- TSS is a conservative tactical prover for forcing chains (VCT/VCF style), adapted to Rift rules.
- Root safety rejects moves that immediately lose (including rift “exact-5 trimming” losses) or that allow an immediate opponent single-stone win (Ko-respecting), even under very small time budgets.
- File: `src/lib/game/ai/search.ts`, `src/lib/game/ai/tss.ts`.

---

### Search core: iterative deepening + alpha-beta(PVS)

```mermaid
flowchart TD
  id["IterativeDeepening"] --> dloop["Depth=1_to_maxDepth"]
  dloop --> asp["Aspiration_window"]
  asp --> ab["AlphaBeta_PVS"]
  ab --> best["Update_best_so_far"]
  best --> stop{"TimeManager_stop?"}
  stop -->|yes| done["Return_best_so_far"]
  stop -->|no| dloop
```

```mermaid
flowchart TD
  node["AlphaBeta_node"] --> time{"Time_up?"}
  time -->|yes| abort["Abort_slice"]
  time -->|no| tt["TT_probe(withTurn(hash,toMove))"]
  tt -->|usable| cut["Return_TT_score"]
  tt -->|not_usable| gen["Generate_and_order_moves"]
  gen --> pvs["PVS_loop"]
  pvs --> store["TT_store(bestScore,bestMove,flag)"]
  store --> ret["Return_best"]
```

Move ordering & pruning (where strength/speed tradeoffs live):
- TT best-move hint, killer moves, history + countermove + continuation history: `src/lib/game/ai/moveOrder.ts`.
- Root progressive widening, expanding to the full generated root set after a
  selective loss; optional NNUE-assisted top-K reordering.
- Razoring + NMP + LMP + LMR + futility pruning + quiescence (tactical stability via `generateTacticalMoves`): `src/lib/game/ai/search.ts`.

---

### Pondering (dual-session reuse)

```mermaid
flowchart TD
  humanTurn["HumanTurn"] --> rootSession["ponderRootSession(human_to_move)"]
  rootSession --> predict["Predict_human_bestMove"]
  predict --> childHash["predictedChildHash"]
  childHash --> replySession["ponderReplySession(ai_reply_on_child)"]
  replySession --> deepen["Deepen_reply_session"]

  aiTurn["AITurn"] --> hit{"Ponder_hit?"}
  hit -->|yes| reuse["Continue_replySession(full_time_budget)"]
  hit -->|no| fresh["Fresh_findBestMove"]
```

Notes:
- Engine only starts pondering in `vs-ai` during the human turn (when `currentPlayer !== aiColor`).
- The worker runs a slice loop (`sliceMs` per tick) for up to ~5s, spending most of the work on the predicted reply session, and snapshots a `ponder` summary when pausing.
- On a ponder hit (current position hash equals `predictedChildHash`), the worker continues the reply session via `SearchSession.searchSlice(timeLimitMs)` instead of starting a fresh `findBestMove`.

Implementation:
- `src/lib/game/ai.worker.ts`: maintains `ponderRootSession` + `ponderReplySession`, reuses reply session on hit.
- `src/lib/game/engine.ts`: starts/stops pondering and logs a “ponder impact” report when the move returns.

---

### Performance techniques (what makes it fast in this codebase)

This section lists the main performance-oriented techniques that are implemented today, with pointers to the relevant modules.

- **Packed board + incremental hashing (avoid expensive copies/scans)**
  - Board state is a compact `Uint8Array(225)` with stone counters and `koPosition`: `src/lib/game/ai/board.ts`, `src/lib/game/ai/types.ts`.
  - Zobrist hashing is updated incrementally on every stone add/remove and Ko change (`updateHash`, `updateKoHash`), and TT keys add side-to-move via `withTurn`: `src/lib/game/ai/zobrist.ts`.
  - Win checking is incremental at the node level: `getWinnerAfterMove` checks only the affected points (reinforce placements, or lines through the rifted cell) instead of scanning the whole board: `src/lib/game/ai/board.ts`.
  - Colinearity “shield” legality checks scan between the two stones without allocating intermediate arrays: `src/lib/game/ai/board.ts` (`checkColinearityConstraint`), also mirrored in `src/lib/game/ai/synergy.ts` (`usesShieldException`).

- **Typed-array transposition table + compact move encoding (reduce GC pressure)**
  - TT uses typed arrays (`BigUint64Array` keys + compact typed fields) and 2-way set associativity: `src/lib/game/ai/transposition.ts`.
  - Moves are encoded into a signed 32-bit integer for TT/heuristic storage (`moveCodec.ts`), avoiding object allocation in caches: `src/lib/game/ai/moveCodec.ts`.
  - Mate-distance/terminal scores are stored in a ply-neutral form in TT so they remain valid across transpositions: `src/lib/game/ai/transposition.ts` (`toTTScore`/`fromTTScore`).
  - Shared slots have atomic sequence versions: writers claim a slot without waiting, and readers reject overlapping updates, including same-key rewrites. This adds four bytes per shared entry; non-shared tables do not allocate versions.
  - While opening filters are pending, search uses cached move hints only. Filter-dependent scores are neither read nor written because callback identity and future opening restrictions are absent from the board hash.

- **Stamp-based scratch masks (replace `Set` allocations in hot paths)**
  - Candidate generation de-dup uses a `Uint32Array` “seen” mask with an incrementing stamp (`CANDIDATE_SEEN`): `src/lib/game/ai/moveGen.ts`.
  - Reinforce pair de-dup uses a numeric pair key + `PAIR_SEEN` stamp mask: `src/lib/game/ai/moveGen.ts`.
  - Threat/blocking computation uses a shared `BLOCK_MASK` with stamps: `src/lib/game/ai/threats.ts` (`getBlockingMask`).
  - Winning-square discovery uses a `WIN_MASK` stamp mask to avoid repeated pushes: `src/lib/game/ai/threats.ts` (`getSingleStoneWinningSquares`).
  - Pattern counting de-dups counted lines using a `COUNTED_LINES` stamp mask (avoids allocating per-line keys): `src/lib/game/ai/patterns.ts` (`countPatterns`).
  - `scanLine` / `LineInfo` is intentionally scalar (e.g. `gapPos`, `extend1`, `extend2`) to avoid per-call array allocations in the pattern hot path, and line scans are bounded (`maxRun = 6`): `src/lib/game/ai/patterns.ts`.

- **Precomputed tables (movegen + evaluation)**
  - Candidate neighbor lists within `CONFIG.CANDIDATE_RADIUS` are precomputed once (`NEIGHBORS`) for fast “near-stone” candidate enumeration: `src/lib/game/ai/moveGen.ts`.
  - `CENTER_BONUS` is precomputed for positional scoring: `src/lib/game/ai/constants.ts`.
  - `createReinforceScorer` evaluates each candidate placement once per generation call. Legal pairs cannot alter each other's line patterns: they are non-collinear or separated by an opponent stone. Pair scoring reuses those independent results, including attack and fork information.
  - Opening-filter fallback enumeration reuses the same cached placement scorer when searching beyond the local candidate set, including Black's restricted second move in Long Pro.
  - Single-stone scoring squares come from exact contiguous-run counts, including stones across a gap. A pattern label is insufficient: filling `XXXX_X` produces an overline, not a score.

- **Branching-factor control by construction**
  - Candidate/move list sizes are capped (`CONFIG.MAX_CANDIDATES`, `CONFIG.MAX_PAIRS`, `CONFIG.MAX_RIFTS`), and root search additionally uses progressive widening: `src/lib/game/ai/constants.ts`, `src/lib/game/ai/moveGen.ts`, `src/lib/game/ai/search.ts`.
  - `generateAllMoves` merges two already-sorted lists (reinforce + rift) to avoid an extra `O(n log n)` sort in the hot path: `src/lib/game/ai/moveGen.ts`.
  - Some hot-path “membership” checks intentionally use small linear scans instead of allocating `Set`s (e.g., tactical win-block detection): `src/lib/game/ai/moveGen.ts` (`generateTacticalMoves`).

- **Search efficiency (ordering + pruning + stable time control)**
  - Alpha-beta uses PVS, aspiration windows, and quiescence with forcing attacks and immediate defenses (`generateTacticalMoves`). Attack pairs are capped after checking that they create a real scoring threat; generated forcing rifts and mandatory defenses survive the cap. Ordering bonuses are not used as delta-pruning bounds.
  - Pruning/reduction suite includes (with conservative guardrails): razoring, null-move pruning (disabled under tactical danger), late-move pruning, late-move reductions, futility pruning: `src/lib/game/ai/search.ts`.
  - Ordering combines TT best-move, killer moves, history, countermove, and continuation history; all backed by typed arrays to avoid per-node allocations: `src/lib/game/ai/moveOrder.ts`.
  - `ScoredMove.orderScore` is stored on the move objects to avoid allocating parallel “order score” arrays per node: `src/lib/game/ai/types.ts`, `src/lib/game/ai/moveOrder.ts`.
  - Some tactical “danger” checks are computed lazily and cached per node to avoid repeated threat scans (`cachedDanger`): `src/lib/game/ai/search.ts`.
  - Iterative deepening stops via a small `TimeState` gate (soft/hard limits) rather than only “time up” checks: `src/lib/game/ai/timeManager.ts`, `src/lib/game/ai/search.ts`.
  - Search depth decreases on every move, with bounded quiescence at the frontier. Repeated tactical moves cannot keep the nominal depth fixed indefinitely.
  - PVS keeps the established best move on equal returned scores, since a null-window fail-low bound does not establish a genuine tie. Quiescence cannot stand pat against an immediate scoring threat. It checks legal match-winning singles even at its depth boundary and examines forcing attacks before declaring a position quiet.
  - Futility pruning compares the parent position evaluation with alpha and is limited to quiet non-PV nodes. Ordering bonuses cannot prune root alternatives. A selective loss no longer stops iterative deepening early.
  - Unsearched fallbacks use bounded position values. If root safety replaces a move, its score and depth are recalculated instead of retaining the discarded principal variation's metadata.

- **Evaluation hot-path micro-optimizations**
  - Pattern scoring avoids `Object.entries` and similar allocation-heavy constructs in the evaluation hot path: `src/lib/game/ai/evaluate.ts`.
  - Nonterminal heuristic scores, including match-point adjustments, are bounded below the mate-score range. Large fork penalties cannot be mistaken for a proven loss or trigger a false resignation.
  - Line scanning uses precomputed board geometry and scans each contiguous run once when counting patterns. A gap variant joins exactly two adjacent runs; it cannot combine two separate gaps into a phantom threat.
  - A search-local cache holds up to 16,384 handcrafted values keyed by board, ko and player. Match points are applied separately. Helper functions that temporarily mutate cells never access this cache. Ponder sessions retain it only for their current position.
  - Move generation and fork detection share precomputed candidate neighborhoods. Match-ending single-stone moves bypass pair scoring.

- **TSS (tactical prover) bounded + memoized**
  - Threat space search is bounded by `maxPlies/maxAttackerMoves/maxDefenderMoves`, memoizes by `withTurn(hash,toMove)`-derived keys, and keeps a small cross-call root cache: `src/lib/game/ai/tss.ts`.
  - TSS uses compact move encoding in memo entries (`encodeMove`/`decodeMove`) to keep caches small: `src/lib/game/ai/tss.ts`, `src/lib/game/ai/moveCodec.ts`.
  - TSS receives at most 30% of the remaining timed budget, capped at 2.5 seconds. Defensive hints do not bypass the remaining full search. TSS is skipped when opening filters are pending because it does not model them.
  - The attacker quota is applied after testing whether each generated move creates a forcing threat; nonforcing moves cannot consume that quota.

- **NNUE incremental evaluation (fast leaf eval + ordering assistance)**
  - Incremental accumulator (`NnueState`) supports O(hiddenDim) updates per move and avoids re-evaluating from scratch: `src/lib/game/ai/nnue/evaluator.ts`.
  - Root move ordering optionally rescoring the top-K moves with NNUE uses cheap “apply move → eval → unapply move” loops: `src/lib/game/ai/search.ts`.
  - NNUE updates include all stones cleared by scoring and restore them on undo, including rifts that award points to the opponent. Current browser workers pass null weights; optional NNUE remains available to direct search/training callers.

- **Worker-level reuse + responsiveness**
  - Workers keep playing legal moves instead of resigning from a selective search score. Mate-coded scores from a bounded candidate search do not certify that every legal defense loses.
  - Pondering uses two search sessions (root prediction + reply) and reuses the reply session on a ponder hit via `SearchSession.searchSlice`, preserving TT/history/PV state: `src/lib/game/ai.worker.ts`, `src/lib/game/ai/search.ts`.
  - The ponder loop yields to the worker event loop (`setTimeout(resolve, 0)`) to remain responsive under continuous background search: `src/lib/game/ai.worker.ts`.
  - UltraV2 workers each search the whole root. Their coordinator prioritizes proven wins, then completed depth, then score; a shallow optimistic estimate cannot displace deeper analysis merely because its number is higher.

- **Measurement & regression harnesses (supporting performance work)**
  - Nodes/sec benchmark with warm-up and fresh TT/history for each measured repetition: `src/lib/game/ai/benchmark.ts`.
  - `scripts/bench_ai.mjs` bundles the engine before timing and uses the same current fixtures/cache-reset policy for reference checkouts. These are Node engine measurements, not browser UI timings.
  - `scripts/compare_ai.mjs` compares fixed move-generation workloads and paired, color-swapped matches against a separate source checkout. `scripts/*.test.mjs` provide deterministic correctness checks plus a concurrent shared-TT stress test.
  - Tactical regression puzzles cover tricky edge cases (including overline/Ko) and guard against known move-selection pathologies; useful when refactoring for performance: `src/lib/game/ai/puzzles.ts`, `scripts/run_puzzles.ts`.

### Appendix: module map

```mermaid
flowchart LR
  Engine["engine.ts"] --> Worker["ai.worker.ts"]

  Worker --> AIIndex["ai/index.ts"]
  Worker --> NnueWeights["ai/nnue/weights.ts"]

  AIIndex --> Search["ai/search.ts"]
  AIIndex --> MoveGen["ai/moveGen.ts"]
  AIIndex --> MoveOrder["ai/moveOrder.ts"]
  AIIndex --> Eval["ai/evaluate.ts"]
  AIIndex --> Threats["ai/threats.ts"]
  AIIndex --> Patterns["ai/patterns.ts"]
  AIIndex --> Board["ai/board.ts"]
  AIIndex --> TT["ai/transposition.ts"]
  AIIndex --> TSS["ai/tss.ts"]
  AIIndex --> TimeManager["ai/timeManager.ts"]

  Search --> MoveGen
  Search --> MoveOrder
  Search --> Eval
  Search --> Threats
  Search --> TT
  Search --> TSS
  Search --> TimeManager
  Search --> Zobrist["ai/zobrist.ts"]
  Search --> NnueEvaluator["ai/nnue/evaluator.ts"]

  MoveGen --> Synergy["ai/synergy.ts"]
  MoveGen --> Threats
  MoveGen --> Board
  MoveGen --> Utils["ai/utils.ts"]

  Eval --> Patterns
  Eval --> Threats
  Eval --> NnueEvaluator

  Threats --> Patterns
  Board --> Zobrist

  TT --> MoveCodec["ai/moveCodec.ts"]
  MoveOrder --> MoveCodec
  TSS --> MoveCodec

  NnueEvaluator --> NnueFeatures["ai/nnue/features.ts"]
  NnueWeights --> NnueFeatures
```

