# Octo Landscape Scan — 2026-04-12

Second pass of the upstream-openclaw scan, this time focused on
Octopus Orchestrator concepts: mission/grip/arm DAGs, multi-model
competitive tournaments, ELO rankings, phase cascades (work → judge
→ verdict), and distributed arm execution across remote hosts.

Same approach as the teleconference scan that produced the outreach
comments 01-04 and RFC #65403.

## TL;DR — We did NOT jump the gun. Octo is novel at the composition level.

The upstream repo has **plenty of adjacent work** on multi-agent
orchestration, but none of it converges on the specific composition
that Octo delivers. The closest prior art covers one or two pieces,
never the whole shape. Specifically:

- **Fan-out/await primitive** exists as a proposal (#38522) but is
  single-cohort only — no auto-cascade, no judge phase, no DAG
- **Long-running task orchestration with DAGs** is aligned (#45522)
  but stops at task-tracking; no multi-model evaluation, no
  competitive scoring
- **Skill-based routing** is in flight (#50073) but pure capability
  matching — no ELO, no outcome-based learning
- **AIs evaluating AIs** exists conceptually (#19212, CLOSED) but was
  off-topic for the repo and used jury consensus, not ELO
- **Agent teams / parallel coordination** exists (#10010) but as
  cooperative task-queue, not competitive tournament
- **Multi-Agent Collaboration Enhancement RFC** (#35203) is the
  bigger architectural vision that Octo provides concrete
  implementation for — meetings RFC already references this

**Nobody else is proposing the specific combination Octo implements:**
mission DAGs + competitive multi-model tournaments + ELO persistence

- judge/verdict phase cascade + distributed cross-host arm execution +
  unified CLI/tmux/ACP adapter.

So no, we didn't duplicate existing work. But we SHOULD acknowledge
the prior art that partially overlaps — same outreach pattern as the
teleconference scan.

## Our own items (verify before assuming they're current)

Both of these are owned by mmartoccia:

| #                                                           | Title                                                                                                                               | Status              | Last update | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [#64392](https://github.com/openclaw/openclaw/pull/64392)   | feat(octo): coordinate multiple AI coding tools as a unified team (feature-flagged, import-isolated, 0 upstream behavioral changes) | Open PR             | 2026-04-10  | The upstream PR. Describes ~70% of what we have locally — missions, arms, grips, claims, leases, policy, recovery. Does NOT yet describe: ELO, competitive tournaments, phase cascade, distributed execution, cross-host SSH+tmux, the 5 execution strategies (competitive, competitive_single_judge, council, collaborative, consensus), auth-failure classification, or the /octo chat surface. All of those are local-only in the fork. |
| [#64435](https://github.com/openclaw/openclaw/issues/64435) | Octopus Orchestrator — multi-agent coordination for OpenClaw                                                                        | Open tracking issue | 2026-04-10  | 2 🚀 reactions, 1 spam comment. The public RFC/announcement for PR #64392. Same scope gap as the PR — doesn't describe the newer features.                                                                                                                                                                                                                                                                                                 |

**Action:** these are both stale relative to the local fork state. A
status-update comment on #64435 bringing it up to current (listing
what's shipped since Apr 10 — ELO, strategies, distributed, /octo
chat, Phase 1 meet verbs, dial handoff, classify-failure) would
refresh the narrative and give readers a more accurate picture of
what we're building.

## Prior art with partial overlap — acknowledge, don't compete

Ordered by overlap strength with Octo's specific compositions.

### [#38522](https://github.com/openclaw/openclaw/issues/38522) — Subagent barrier primitive

**Author:** softengineware | **Engagement:** 0 reactions, 0 comments | **Status:** Open, no maintainer response

**What they proposed:** `sessions_spawn_barrier({tasks, awaitMode: "all"|"any"|{minComplete:N}, timeout})` — spawn N subagents in a cohort, wait for completion with configurable policy, return atomic result set. Addresses "fragile coordination logic" and "token-inefficient polling" in manual patterns.

**Overlap with Octo:** This is essentially **Phase 1 of a competitive grip** distilled as its own primitive. `spawn N work arms → await all → return combined results` is what `competitive_single_judge` does for the work phase. But it stops there — no cascade to judge arms, no verdict synthesis, no competitive scoring.

**How to engage:** Frame Octo's phase cascade as the "next layer up" from their barrier primitive. Their single-cohort fan-out/await is exactly what Octo uses under the hood to execute one grip phase; Octo adds the DAG edges so cohorts trigger each other. Point them at `src/octo/head/strategies/competitive.ts` for the concrete example.

---

### [#45522](https://github.com/openclaw/openclaw/issues/45522) — Long-Running Task Orchestration with Real-Time Progress Feedback

**Author:** (check) | **Engagement:** 1 👍, 3 comments (some hidden as spam) | **Status:** Open, moderate maintainer engagement from Ryce

**What they proposed:** Task state machines with step-level status tracking, real-time progress streaming, deviation detection with self-correction, templates like `research→deliver`, `monitor→alert`, `build→deploy`.

**Maintainer signal (important):** Ryce responded with detailed technical critique, noting that `streamTo: "parent"` covers real-time sub-agent output but acknowledging genuine gaps in _structured_ step state machines, per-step timeouts with retry, and framework-level deviation signals. This is the **first real maintainer engagement** I've seen on an orchestration proposal — worth taking seriously.

**Overlap with Octo:** Very high on the conceptual axis. Octo's mission/grip model _is_ a DAG of long-running tasks with progress observability — per-grip state machine, heartbeat-backed leases for deviation detection, event-log for streaming progress. The mission execution flow `create → phase cascade → completion` maps directly to the templates they describe.

**How to engage:** This is where the strongest maintainer signal lives. Post a comment that demonstrates Octo implements the concrete shape Ryce said was missing (structured step state, per-step timeouts, deviation via lease expiration). Reference commit `64392` for the implementation. This is the outreach item most likely to move.

---

### [#50073](https://github.com/openclaw/openclaw/issues/50073) — Skill-based task routing for multi-agent setups

**Author:** Hollychou924 | **Engagement:** 2 comments (hidden as spam) | **Status:** Open, no maintainer response, self-scoped two-phase design

**What they proposed:** Phase 1 — capability index injected into coordinator system prompt (~200 LOC). Phase 2 — optional auto-routing for unambiguous tasks (~350 LOC). Both phases default-disabled.

**Overlap with Octo:** Medium. Their routing is purely capability-based (what agents _can_ do). Octo's ELO feature adds the other axis: which agents have _historically won_ at similar tasks. These compose — capability is the eligibility filter, ELO is the tie-breaker. Together you get "eligible agents sorted by historical success on similar topics."

**How to engage:** Frame Octo's ELO as the performance feedback loop their routing proposal could plug into. Their capability index answers "who CAN do this", ELO answers "who has been BEST at this kind of thing." Complementary, not competing.

---

### [#10010](https://github.com/openclaw/openclaw/issues/10010) — Feature Request: Agent Teams - Parallel Agent Coordination

**Author:** (check) | **Engagement:** 2 👍, 12 comments, an attempted implementation PR (#27382) | **Status:** Open, some community development momentum but no maintainer sign-off

**What they proposed:** Cooperative team primitives — shared task queue with self-assignment, peer-to-peer messaging (`team_send`, `team_broadcast`), team lifecycle (`team_create`, `team_status`, `team_dissolve`), visualization dashboards. Use cases: parallel code review, hypothesis-driven debugging, parallel feature development.

**Overlap with Octo:** Same problem space (coordinate multiple agents on one task) but **opposite paradigm**: cooperative task-queue vs. Octo's competitive dispatch. Both are valid — cooperative is better when agents have complementary specialties, competitive is better when you want the best of N independent attempts.

**How to engage:** Acknowledge the paradigm difference. Both should exist. Octo's missions can in principle be cooperative (the `council` and `collaborative` strategies already are — no voting, just shared output merging) so there's overlap in the cooperative modes. Point at `src/octo/head/strategies/council.ts` and `collaborative.ts`.

---

### [#35203](https://github.com/openclaw/openclaw/issues/35203) — RFC: Multi-Agent Collaboration Enhancement (Capability Profiling + Blackboard + Layered Memory + Token Governance)

**Already engaged** during the teleconference outreach (comment 03). The Octo relationship should be added to that comment or as a new comment: Octo implements concrete Layer 1 (capability profiling via ELO) and partial Layer 2 (mission artifacts are the beginnings of a blackboard).

## Prior art with no overlap — ignore

These showed up in searches but turned out to be different problems:

| #                                                           | Title                                    | Why not                                                               |
| ----------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------- |
| [#45337](https://github.com/openclaw/openclaw/issues/45337) | Agent Orchestration + Integrations Hub   | n8n/Zapier-style marketplace, not task dispatch                       |
| [#46048](https://github.com/openclaw/openclaw/issues/46048) | workflow-as-list DSL                     | Sequential list, not DAG, no parallelism                              |
| [#62478](https://github.com/openclaw/openclaw/issues/62478) | Background sub-agent spawn mode          | Async spawn pattern only, no coordination                             |
| [#50038](https://github.com/openclaw/openclaw/issues/50038) | Multi-Agent & Sub-Agent Workflows        | Diagnostic post on existing bugs, not a design                        |
| [#19212](https://github.com/openclaw/openclaw/issues/19212) | AIs Evaluate AIs (Moltbook)              | **CLOSED** — off-topic for openclaw, about a separate social platform |
| [#40104](https://github.com/openclaw/openclaw/pull/40104)   | ECS extension plugin                     | **CLOSED** — author said "belongs on our fork, not upstream"          |
| [#58464](https://github.com/openclaw/openclaw/pull/58464)   | Sokosumi marketplace orchestration skill | Marketplace integration, not orchestration primitive                  |

## What's genuinely novel about Octo in this landscape

After reading everything, these are the Octo-specific inventions that
have zero prior art in openclaw:

1. **Competitive multi-model tournament as a first-class mission type.** Nobody else proposes "run the same task on N models in parallel and pick the winner via judge arms." The `competitive` and `competitive_single_judge` execution modes are unique.

2. **Phase cascade auto-spawn.** The pattern where completing grip A automatically triggers grip B's arm with A's output as input, encoded as DAG edges, is not in any other proposal. The closest is the barrier primitive (#38522) but it doesn't cascade.

3. **ELO ranking persistence across missions.** Nobody else tracks agent performance with a learning system. #50073 sketches capability routing, #35203 sketches capability profiling, but neither implements a competitive rating that updates over time from real tournament outcomes.

4. **Distributed arm execution across hosts via SSH+tmux.** Nobody else has proposed running different agents on different physical machines as part of the same mission. The remote_nodes config, the `--target-node` CLI flag, and the NodeAgent remote sentinel polling are all unique to Octo.

5. **Unified ArmSpec across adapters.** The fact that an arm can be `pty_tmux`, `cli_exec`, `structured_subagent`, or `structured_acp` behind the same spec shape is a composition the other proposals don't attempt. They either pick one runtime (cli only, or subagent only, or ACP only) or ignore runtime entirely.

6. **Mission → grip → arm → claim → lease as a coherent primitive set.** Each piece shows up individually in the landscape (claims in #52788 "multi-agent context hardening", leases in various sub-agent proposals) but nobody else composes them into a single orchestration model with well-defined state transitions.

7. **The `/octo` chat surface.** Unique — no other proposal puts the orchestration system behind a chat slash command with read + mutating verbs and an approval gate.

## Recommended outreach

Mirroring the teleconference plan that produced #65403 and the four
comments:

1. **Comment on #38522** — engage softengineware, frame Octo's phase cascade as the layer above their barrier primitive, share `src/octo/head/strategies/competitive.ts`
2. **Comment on #45522** — engage Ryce directly on the maintainer-visible thread, demonstrate that Octo's mission/grip/lease model implements the "structured step state + per-step timeouts + deviation signals" they said were missing
3. **Comment on #50073** — engage Hollychou924, frame ELO as the performance-feedback layer their capability routing could plug into
4. **Comment on #10010** — engage with the cooperative-vs-competitive paradigm difference, point at `council` and `collaborative` strategies that cover their use cases
5. **Update comment on #35203** — the existing teleconference comment already references Octo's ELO; extend with the phase cascade + distributed execution story
6. **Status update on #64435** — bring the tracking issue up to current with what's shipped locally since Apr 10: ELO, 5 execution strategies, distributed arms, /octo chat, Phase 1 meet verbs, classify-failure, per-node concurrent caps
7. **File a new RFC** — "Octo follow-up: competitive tournaments, ELO, distributed execution, and the /octo chat surface" — updates #64435 with a concrete roadmap for the features not yet in PR #64392, cross-referencing all the above

**Recommended posting order:**

1. #64435 status update first (brings the public narrative up to date before anyone else reads the scan comments)
2. #45522 (highest-leverage — real maintainer engagement, high conceptual alignment)
3. #38522 (concrete overlap, cleanest comment to write)
4. #50073 (composes neatly with ELO)
5. #10010 (paradigm contrast, worth the acknowledgment)
6. #35203 extension (low effort, high coverage)
7. Optional new RFC if #64435 update doesn't land the right signal within a week

## What NOT to post

- Do not file a new Octo RFC until the #64435 update is absorbed.
  The tracking issue exists; another RFC would fragment the
  conversation.
- Do not comment on #19212 or #40104 (closed, out-of-scope).
- Do not comment on #45337, #46048, #50038, #62478, #58464 (no real
  overlap — comments would come across as spam).

## Honest assessment

**Octo is novel enough that we're not duplicating work.** The concern
that triggered this scan was valid to raise — the landscape is crowded
— but the specific composition we're building (competitive tournaments

- ELO + phase cascades + distributed execution + unified ArmSpec) is
  not in any of the existing proposals. Several proposals cover adjacent
  primitives (barrier, long-running DAG, capability routing, agent
  teams) and Octo composes ideas from all of them, but no single
  proposal covers more than ~30% of Octo's surface.

**The risk is not duplication — it's fragmentation of the
conversation.** If we don't engage with the adjacent proposals, their
authors may build competing implementations that don't interop with
Octo, and we end up with three half-complete orchestration layers
instead of one coherent one. The outreach above is cheap insurance
against that.
