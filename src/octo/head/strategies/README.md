# Execution Strategies (`src/octo/head/strategies/`)

Graph expanders and judge prompt builders for multi-model execution strategies.

Each strategy takes a single grip + N arm templates and expands into a multi-phase DAG with auto-spawning, dependency tracking, and output artifact persistence.

## Implemented

### `competitive.ts`

Two expanders:

- **`expandCompetitiveGraph()`** — Round-robin peer review. N work + N judge + 1 verdict = 2N+1 grips. Each model judges the other N-1 models' outputs.
- **`expandSingleJudgeGraph()`** — Single judge. N work + 1 judge = N+1 grips. One designated model reviews all outputs.

Both produce an `ExpandedGraph` containing the grip DAG and a per-grip arm template map. The map is persisted in mission metadata (`_arm_templates_by_grip`) so the NodeAgent's phase cascade can spawn judge/verdict arms with the correct prompts when their dependencies complete.

## Planned

- **`council.ts`** — Parallel input, merged output. No losers.
- **`collaborative.ts`** — Sequential refinement. Each model builds on the prior.
- **`consensus.ts`** — Independent convergence. Must agree to proceed.

## Adding a new strategy

1. Create `<strategy>.ts` with an `expand<Strategy>Graph()` function
2. Return `ExpandedGraph` with `graph` (DAG nodes) and `armTemplatesByGrip` (per-grip templates)
3. Wire it into `gateway-handlers.ts` `missionCreate()` Step 4b
4. Add the mode to `MissionExecutionModeSchema` in `wire/schema.ts`
