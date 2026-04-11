# Octopus Orchestrator

**One head. Many arms. Any tool.**

Octopus is a multi-agent orchestration subsystem for [OpenClaw](https://github.com/openclaw/openclaw) that coordinates multiple agentic coding tools — Claude Code, OpenAI Codex, Gemini CLI, Cursor, Copilot, or any future tool — as a unified team working on a single codebase.

## Why This Exists

Every major agentic coding tool today operates in isolation. Claude Code works alone. Codex works alone. Gemini CLI works alone. Each one occupies a single context window, processes a single task at a time, and has no awareness of what any other agent is doing.

This is the bottleneck.

Real software work is parallel. A feature branch needs frontend changes, backend API updates, database migrations, test coverage, and documentation — simultaneously. A large refactor touches dozens of files across multiple subsystems. A research spike needs to explore several approaches at once and converge on the best one. Today, a developer using agentic coding tools does these things sequentially, one agent session at a time, manually coordinating the results.

**The tools are single-threaded. The work is not.**

### What's missing from the ecosystem

We surveyed every serious multi-agent orchestration project in the terminal-native space. The ecosystem has strong partial solutions, but no complete one:

| What exists                                                                          | What's missing                                                                 |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| **Distributed mission dispatch** (Fleet/fleetspark) — can route work across machines | No real terminal control, Git-as-message-bus is too crude for rich supervision |
| **Local fleet plumbing** (ai-fleet) — tmux + worktree session management             | Too weak as a control plane, no shared state, no policy enforcement            |
| **PTY embodiment** (PiloTY) — drives interactive terminals like a human              | No coordination, no safety boundaries, no multi-agent awareness                |
| **Agent conversation rooms** (AgentPipe) — observability and multi-agent chat        | Not enough control plane, no execution management                              |
| **Protocol-centered orchestration** (ccswarm) — ACP-based coordination               | Locked to a single protocol, brittle when vendors change their APIs            |

Every one of these solves one or two layers well. None of them unify all four: **session execution**, **terminal control**, **multi-agent coordination**, and **distributed mission planning**.

Octopus is that unification.

### Why build it inside OpenClaw

OpenClaw is already a multi-provider, multi-channel platform with device pairing, remote nodes, background task execution, a plugin system, and a Gateway that handles WebSocket dispatch. It has the substrate. What it didn't have was a supervisor that could take all of that machinery and use it to coordinate multiple coding agents working on the same problem at the same time.

Octopus fills that gap. It turns OpenClaw from a chat-layer-plus-tools into an **operating substrate for coordinated agent work**.

## How It Works

### The key insight: drive tools like a human would

Octopus drives external agentic coding tools the way a developer at a terminal would. When it runs Claude Code as an arm, it invokes `claude` the same way you would — via the CLI's structured output mode or through an interactive PTY/tmux session. Same binary, same credentials, same session model.

This matters for three reasons:

1. **Durability.** CLIs are stable surfaces with long-lived contracts. Programmatic protocols are younger and break more often.
2. **Pluggability.** Any new tool that ships as a CLI plugs in without writing adapter code. We don't wait for vendors to implement any particular protocol.
3. **Inspectability.** A human operator can attach to any arm's tmux session and see exactly what the agent is doing in real time, as if they were sitting at the keyboard.

### Four adapter types

| Adapter               | How it works                                                      | Best for                                                                  |
| --------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `cli_exec`            | Spawns the tool as a subprocess, consumes structured CLI output   | Tools with `--json` or `--output-format stream-json` (Claude Code, Codex) |
| `pty_tmux`            | Launches the tool in a tmux session, drives it via PTY keystrokes | Interactive TUI tools, any tool without structured output                 |
| `structured_subagent` | OpenClaw's own native agent loop, no external tool                | Work that fits OpenClaw's built-in model provider                         |
| `structured_acp`      | ACP protocol via the ACPX plugin                                  | ACP-only runtimes (opt-in, not default)                                   |

A single mission can mix all four. Parallel arms with different runtimes work simultaneously in sibling git worktrees, coordinated by claims so they never collide.

### Architecture

```
                    ┌─────────────────────────────┐
                    │         Operator             │
                    │  CLI / Chat / Agent Tools    │
                    └──────────┬──────────────────┘
                               │
                    ┌──────────▼──────────────────┐
                    │       Octopus Head           │
                    │  Scheduler · Registry · FSMs │
                    │  Policy · Claims · Leases    │
                    │  EventLog · GraphEvaluator   │
                    └──────────┬──────────────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
     ┌────────▼─────┐  ┌──────▼──────┐  ┌──────▼──────┐
     │  Node Agent   │  │ Node Agent  │  │ Node Agent  │
     │  (laptop)     │  │ (desktop)   │  │ (remote)    │
     └───┬───┬───┬──┘  └──┬───┬──┬──┘  └──┬───┬──┬──┘
         │   │   │        │   │  │        │   │  │
        arm arm arm     arm arm arm     arm arm arm
```

**Head** plans missions, schedules grips, enforces policy, manages leases and claims, and tracks everything in a SQLite-backed registry with a full event log.

**Node Agents** run on each machine (laptop, desktop, remote server). They spawn and supervise arms, manage tmux sessions, heartbeat leases, and reconcile state after crashes.

**Arms** are the actual worker agents — each one is a running instance of Claude Code, Codex, Gemini CLI, or any other tool, executing inside its own git worktree with exclusive file claims.

## Use Cases

### Parallel feature development

Spawn 5 arms to work on different parts of the same feature simultaneously — one on the API, one on the frontend, one on tests, one on migrations, one on documentation. Each works in its own worktree. Claims prevent file collisions. The mission graph defines dependencies.

### Large-scale refactoring

Break a 200-file refactor into 20 grips. Octopus schedules them across available arms, respects dependency ordering, and handles the case where an arm stalls or dies mid-refactor.

### Multi-tool comparison

Run the same prompt through Claude Code, Codex, and Gemini CLI in parallel. Compare the outputs. Pick the best one. No manual context-switching.

### Distributed builds and testing

Spread compilation, linting, and test execution across multiple machines. A remote server runs the heavy compute while your laptop handles the coordination.

### Research spikes

Explore 3 different approaches to a problem simultaneously. Each arm investigates one approach. Abort the losers, keep the winner, merge the results.

### Supervised autonomy

Let arms work independently but with guardrails — policy enforcement, approval gates, budget limits, and the ability for a human to attach to any arm at any time and take over.

## Execution Strategies

Missions support multiple execution strategies via the `execution_mode` field. Each strategy defines how arms are spawned, how work is evaluated, and how the final output is selected.

### `direct_execute` (default)

One arm per grip. Simple task execution. No competition, no review.

```bash
openclaw octo mission create \
  --title "Add login page" \
  --grip "login-page" \
  --arm-template claude-code \
  --prompt "Create a login page component"
```

### `competitive` — Round-Robin Peer Review

N models compete on the same task. Each model reviews the other models' outputs. A verdict aggregates all reviews and selects the winner.

**How it works:**

1. **Phase 1 — Work** (parallel): Each model independently solves the task
2. **Phase 2 — Peer Review** (parallel, auto-triggered): Each model reviews the other N-1 solutions. Claude reviews Codex+Gemini. Codex reviews Claude+Gemini. Gemini reviews Claude+Codex.
3. **Phase 3 — Verdict** (auto-triggered): Aggregates all peer reviews, selects the winner, updates ELO ratings

```bash
openclaw octo mission create \
  --title "Design auth middleware" \
  --execution-mode competitive \
  --grip "auth-middleware" \
  --arm-template claude-code codex gemini \
  --prompt "Design and implement JWT auth middleware for Express"
```

This creates 7 grips (3 work + 3 judge + 1 verdict) and auto-spawns 3 arms. The judge and verdict arms spawn automatically when their dependencies complete. A single output artifact persists on the completed mission.

**Graph structure (3 models):**

```
work:claude-code ─┐
work:codex ───────┼──▶ judge:claude-code (reviews codex + gemini) ─┐
work:gemini ──────┘    judge:codex (reviews claude + gemini) ──────┼──▶ verdict
                       judge:gemini (reviews claude + codex) ──────┘
```

### `competitive_single_judge` — One Judge Reviews All

Same as competitive but with a single designated judge instead of peer review.

```bash
openclaw octo mission create \
  --title "Optimize query" \
  --execution-mode competitive_single_judge \
  --grip "query-optimization" \
  --arm-template claude-code codex gemini \
  --prompt "Optimize the user search query for 10M+ rows"
```

Creates 4 grips (3 work + 1 judge). Simpler, faster, but single point of evaluation.

### `council` (planned)

N models each produce input. A synthesizer merges all inputs into a unified output that combines the best ideas from each. No losers — every model's contribution is incorporated.

Best for: complex design decisions, architecture reviews, multi-perspective analysis.

### `collaborative` (planned)

Models work sequentially, building on each other's output. Model A drafts → Model B critiques and improves → Model C refines. Each iteration produces a better artifact.

Best for: iterative refinement, code review chains, progressive enhancement.

### `consensus` (planned)

N models must independently converge on the same answer. If they disagree, the task is re-run with additional context until agreement is reached. Validates correctness through independent reproduction.

Best for: high-stakes decisions, security-critical code, mathematical proofs.

### Composability

Each mission is an atomic composable unit:

- **Input**: prompt text or artifact from a prior mission
- **Output**: single artifact file, path stored in mission metadata (`_output_artifact`)
- **Status**: queryable via `openclaw octo mission show <id> --json`

Missions chain by reading the output artifact of one mission as the input to the next. This enables workflows of workflows — campaigns that compose missions the same way missions compose grips.

### Tool Scoping

Arm templates support `tool_scope` to restrict which tools and MCP servers the spawned CLI loads. This keeps memory lean when running multiple arms in parallel:

```json
{
  "arm_templates": [
    {
      "adapter_type": "pty_tmux",
      "runtime_name": "claude-code",
      "agent_id": "main",
      "runtime_options": { "command": "claude", "args": ["-p"] },
      "tool_scope": {
        "tool_allow": ["read", "write", "bash", "grep"],
        "mcp_deny": ["gpd-*", "grepika"]
      }
    }
  ]
}
```

## Quick Start

### Enable Octopus

```bash
openclaw config set octo.enabled true
```

Restart the Gateway. Verify:

```bash
openclaw octo status
openclaw octo doctor
```

### Create a mission

```bash
openclaw octo mission create \
  --title "Add user preferences API" \
  --grip "api-endpoint" \
  --grip "database-migration" \
  --grip "frontend-ui" \
  --grip "test-coverage"
```

### Spawn arms to work on the mission

```bash
openclaw octo arm spawn \
  --mission <mission_id> \
  --adapter pty_tmux \
  --runtime tmux:bash \
  --agent-id default \
  --cwd /path/to/repo

# Or use cli_exec for tools with structured output:
openclaw octo arm spawn \
  --mission <mission_id> \
  --adapter cli_exec \
  --runtime claude-code \
  --agent-id default \
  --cwd /path/to/repo \
  --command claude \
  --args "-p" "--output-format" "stream-json"

# Or provide a full ArmSpec as JSON:
openclaw octo arm spawn --spec-file arm-spec.json
```

### Monitor

```bash
openclaw octo status          # Dashboard
openclaw octo mission list    # All missions
openclaw octo arm list        # All active arms
openclaw octo grip list       # All grips and their status
openclaw octo events          # Live event stream
```

### Inspect and intervene

```bash
openclaw octo arm show <arm_id>       # Detailed arm state
openclaw octo arm attach <arm_id>     # Attach to the arm's tmux session
openclaw octo mission pause <id>      # Pause a mission
openclaw octo mission abort <id>      # Abort a mission
```

## CLI Reference

| Command                         | Description                                                         |
| ------------------------------- | ------------------------------------------------------------------- |
| `octo status`                   | Subsystem dashboard — missions, arms, grips, claims                 |
| `octo doctor`                   | Health checks (feature flag, storage, tmux, etc.)                   |
| `octo init`                     | Initialize the registry and storage                                 |
| `octo mission create`           | Create a mission (`--execution-mode`, `--arm-template`, `--prompt`) |
| `octo mission list`             | List all missions                                                   |
| `octo mission show <id>`        | Show mission details                                                |
| `octo mission pause <id>`       | Pause a running mission                                             |
| `octo mission resume <id>`      | Resume a paused mission                                             |
| `octo mission abort <id>`       | Abort a mission and terminate its arms                              |
| `octo arm list`                 | List all arms                                                       |
| `octo arm show <id>`            | Show arm details and event history                                  |
| `octo arm spawn`                | Spawn a new arm from an ArmSpec (flags or JSON)                     |
| `octo arm attach <id>`          | Attach to an arm's tmux session (interactive)                       |
| `octo arm terminate <id>`       | Terminate an arm                                                    |
| `octo arm restart <id>`         | Restart a failed arm                                                |
| `octo grip list`                | List all grips                                                      |
| `octo grip show <id>`           | Show grip details                                                   |
| `octo grip reassign <id> <arm>` | Reassign a grip to a different arm                                  |
| `octo claims`                   | List active resource claims                                         |
| `octo events`                   | Tail the event log                                                  |
| `octo runtimes`                 | Discover available agentic tools on this machine                    |
| `octo top`                      | Real-time TUI dashboard                                             |
| `octo node list`                | List cluster nodes                                                  |
| `octo node show <id>`           | Show node details                                                   |

All commands support `--json` for machine-readable output.

## What's Inside

| Layer             | Contents                                                                                                                                                                        | Files              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| **Wire protocol** | Methods, events, features, primitives, TypeBox schemas                                                                                                                          | `wire/`            |
| **Config**        | `octo:` config block loader, schema, validator                                                                                                                                  | `config/`          |
| **Head services** | Registry, ArmFSM, GripFSM, MissionFSM, EventLog, Scheduler, Claims, Artifacts, Leases, Policy, Approvals, Quarantine, Retry, GraphEvaluator, GripLifecycle, WorktreeCoordinator | `head/`            |
| **Strategies**    | Competitive (round-robin peer review), competitive_single_judge, council, collaborative, consensus — graph expanders and judge prompt builders                                  | `head/strategies/` |
| **Node Agent**    | Agent loop, SessionReconciler, TmuxManager, ProcessWatcher, PendingLog, RemoteReconciler, GatewayClient                                                                         | `node-agent/`      |
| **Adapters**      | cli_exec, pty_tmux, structured_subagent, structured_acp + OpenClaw bridge modules                                                                                               | `adapters/`        |
| **CLI**           | All `openclaw octo` subcommands                                                                                                                                                 | `cli/`             |
| **Agent tools**   | Tool schemas for in-conversation orchestration                                                                                                                                  | `tools/`           |
| **Tests**         | 1,436 unit tests, 5 integration tests, 12 chaos tests                                                                                                                           | `test/`            |

## Design Principles

1. **Terminal-first.** Every arm is ultimately controllable through terminal semantics. No vendor dashboard required.

2. **Resumable by default.** Sessions are durable objects, not disposable subprocesses. Crashes are expected. Recovery is automatic.

3. **Provider-flexible.** Octopus does not lock you into any single AI provider, protocol, or agentic coding tool. Any tool with a CLI is a potential arm.

4. **Human-in-the-loop.** Autonomy with guardrails. Policy enforcement, approval gates, budget limits, and the ability to take over any arm at any time.

5. **Inspectable.** Full event log, real-time status, tmux attachment, structured JSON output. You always know what's happening.

6. **One integration surface.** A single `initOctopus()` call in the Gateway startup path. No scattered patches across the codebase. Import isolation enforced by CI.

## Integration

Octopus integrates with OpenClaw through a single entry point:

```typescript
import { initOctopus } from "./octo/index.js";

const octo = await initOctopus({
  rawConfig: config,
  nodeId: os.hostname(),
});

// Wire into Gateway
gatewayMethods.push(...octo.methodNames);
Object.assign(extraHandlers, octo.handlers);
events.push(...octo.pushEventNames);
```

The `src/octo/` directory never imports from OpenClaw internals directly. All integration flows through bridge interfaces in `adapters/openclaw/`, enforced by a CI lint guard. This means upstream OpenClaw changes don't cascade into Octopus breakage.

## Status

Octopus shipped across 5 milestones (150 tasks):

- **M0** — Architecture, wire protocol, config schema, CI boundary enforcement
- **M1** — Head services, registry, FSMs, storage, Node Agent
- **M2** — Adapter layer (cli_exec, pty_tmux, subagent, ACP)
- **M3** — Mission coordination, graph evaluation, grip lifecycle
- **M4** — Distributed execution, leases, multi-node scheduling
- **M5** — Policy, safety, quarantine, compliance, approval gates

The subsystem is live and operational. CLI commands are fully functional. Gateway integration is complete. Disabled by default; enable with `octo.enabled: true`.
