## AI movement strategy (technical overview)

This document describes how Gomoku Rift’s AI chooses moves (reinforce / single-win / rift), how it narrows the move set, evaluates positions, and searches efficiently.

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
  Worker->>Search: findBestMove(board,toMove)
  Search-->>Worker: result(move,score,depth,nodes)
  Worker-->>Engine: result(move,stats,ponderReport)
  Engine->>Engine: validateAndApplyMove
  Engine-->>UI: renderMove
```

Key entrypoints:
- `src/lib/game/engine.ts`: starts/stops pondering, sends `findBestMove`, validates worker results, applies moves.
- `src/lib/game/ai.worker.ts`: time allocation + pondering + calls into engine search.
- `src/lib/game/ai/search.ts`: top-level move selection + iterative deepening alpha-beta.

---

### Core rule model (what a “move” is)

```mermaid
flowchart TD
  turnStart["TurnStart"] --> chooseAction{"Choose_action"}

  chooseAction -->|reinforce| reinforce["Reinforce(two_stones)"]
  chooseAction -->|single_win| singleWin["SingleWin(one_stone_only_if_immediate_win)"]
  chooseAction -->|rift| rift["Rift(remove_opponent_stone)"]

  reinforce --> colinear{"Colinear?"}
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
- `src/lib/game/ai/types.ts`: `Move = ReinforceMove | SingleWinMove | RiftMove`.
- `src/lib/game/ai/board.ts`: legality (`validateReinforce`, `validateRift`), application (`makeMove`/`unmakeMove`), exact-5 win checks (`checkWinAt`, `getWinnerAfterMove`).

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
- Files: `src/lib/game/ai/board.ts`, `src/lib/game/ai/zobrist.ts`, `src/lib/game/ai/transposition.ts`.

---

### Candidate selection: “near existing stones”, then “best scored first”

```mermaid
flowchart TD
  start["Reinforce_movegen"] --> neigh["CandidateSquares(radius=2_around_any_stone)"]
  neigh --> score["ScoreEachSquare(evaluateSinglePosition)"]
  score --> sort["Sort_desc_by_score"]
  sort --> top["Take_topK_candidates"]
  top --> pair["Generate_pairs(validateReinforce+colinearity)"]
  pair --> out["ScoredMove_list_for_search"]
```

Notes:
- The radius filter is a *branching-factor control*. It is not strictly “closest-first”; the ordering is by heuristic score.
- Config knobs live in `src/lib/game/ai/constants.ts` (`CANDIDATE_RADIUS`, `MAX_CANDIDATES`, `MAX_PAIRS`).
- File: `src/lib/game/ai/moveGen.ts` (`getCandidatePositions`, `scoreCandidates`, `generateReinforceMoves`).

---

### “Must-block” logic (tactical priority)

```mermaid
flowchart TD
  pos["Position"] --> oppWins["OpponentWinningSquares(ignoreKo=true)"]
  oppWins --> mustBlock{"Any_winning_square?"}
  mustBlock -->|yes| forceBlocks["Prefer_pairs_including_blocks"]
  mustBlock -->|no| normal["Normal_pairing_from_top_candidates"]
```

- Winning squares come from pattern detection (`findWinningPositionsAssumingKoClears`) in `src/lib/game/ai/threats.ts`.
- Blocking squares are assembled via a scratch “blocking mask” from threat patterns (`getBlockingMask`).

---

### Pattern/threat pipeline (how “winning squares” are detected)

```mermaid
flowchart TD
  stone["Stone_at_pos"] --> scan["scanLine(pos,dir)"]
  scan --> classify["classifyLine(count,openEnds,gaps)"]
  classify -->|OPEN_FOUR_or_HALF_FOUR| ext["extendPositions_as_winning_squares"]
  classify -->|GAP_FOUR| gap["gapPositions_as_winning_squares"]
  classify -->|OPEN_THREE| blocks["blocking_mask_marks_extend_or_gap"]
```

Files:
- `src/lib/game/ai/patterns.ts`: `scanLine`, `classifyLine`, `countPatterns`.
- `src/lib/game/ai/threats.ts`: `findWinningPositions*`, `getBlockingMask`, threat levels/forks.

---

### Evaluation stack (handcrafted + optional NNUE)

```mermaid
flowchart TD
  eval["evaluateSearch(board,player)"] --> hasNnue{"NNUE_available?"}
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
- Files: `src/lib/game/ai/nnue/evaluator.ts`, `src/lib/game/ai/nnue/weights.ts`.

---

### Search: top-level decision policy

```mermaid
flowchart TD
  root["findBestMove"] --> quickWin{"Immediate_win_exists?"}
  quickWin -->|yes| playWin["Play_immediate_win"]
  quickWin -->|no| tss["ThreatSpaceSearch"]
  tss -->|proven_win| playTss["Play_proven_forcing_line"]
  tss -->|no_proof| deep["IterativeDeepening_alpha_beta"]
  deep --> safe["sanitizeRootMove(avoid_lose_next)"]
  safe --> out["BestMove"]
```

Notes:
- TSS is a conservative tactical prover for forcing chains (VCT/VCF style), adapted to Rift rules.
- Root safety rejects moves that allow an immediate opponent win even under low time budgets.
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
- TT best-move hint, killer moves, history heuristic: `src/lib/game/ai/moveOrder.ts`.
- Root progressive widening + NNUE-assisted top-K reordering.
- NMP/LMR/futility pruning + quiescence for tactical stability: `src/lib/game/ai/search.ts`.

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

Implementation:
- `src/lib/game/ai.worker.ts`: maintains `ponderRootSession` + `ponderReplySession`, reuses reply session on hit.
- `src/lib/game/engine.ts`: starts/stops pondering and logs a “ponder impact” report when the move returns.

---

### Appendix: module map

```mermaid
flowchart LR
  Engine["engine.ts"] --> Worker["ai.worker.ts"]
  Worker --> Search["ai/search.ts"]
  Search --> MoveGen["ai/moveGen.ts"]
  Search --> MoveOrder["ai/moveOrder.ts"]
  Search --> Eval["ai/evaluate.ts"]
  Search --> TT["ai/transposition.ts"]
  TT --> Zobrist["ai/zobrist.ts"]
  Search --> Threats["ai/threats.ts"]
  Threats --> Patterns["ai/patterns.ts"]
  Search --> TSS["ai/tss.ts"]
  Eval --> NNUE["ai/nnue/*"]
  Search --> Board["ai/board.ts"]
```

