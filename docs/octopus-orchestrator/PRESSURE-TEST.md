# Octopus Orchestrator — Pressure Test Readiness (2026-04-12)

**Read this before deciding the /octo surface is disabled or that this workspace is a frozen planning copy. Both assumptions are wrong.**

## Workspace truth

There is exactly **one** repository that matters for running Octo:

```
/Users/michaelmartoccia/clawd/openclaw_repo-octopus/
```

This directory is:

- The **source tree** (`src/octo/**`, `src/auto-reply/reply/commands-octo.ts`, etc.)
- The **build output** (`dist/index.js`, `dist/schema.sql`)
- The tree the running gateway is executing — `openclaw` is `npm link`-ed to this path. Verify with `ls -la $(which openclaw)` → you will see the symlink land here.

### What about the "planning workspace" STATE.md mentions?

`STATE.md` line 9 names a second path:

```
/Users/michaelmartoccia/.openclaw/workspace/docs/octopus-orchestrator/
```

That path is a **mirror for narrative/history only** — it holds older planning docs and session-log snapshots. It has no code, no `dist/`, no tests, no runtime. The Ralph-loop operating rules in STATE.md say "mirror SESSION-LOG entries to the planning workspace" — it's a read-mostly archive for cross-session continuity, not an alternative build target.

**Do not switch workspaces. This is the live workspace.** If you want to check, run:

```bash
cd /Users/michaelmartoccia/clawd/openclaw_repo-octopus
git log --oneline -5     # you will see recent Octo commits landing on octopus-orchestrator-clean
ls dist/index.js         # exists — this is what the gateway runs
openclaw gateway status  # the running pid is executing this dist/
```

## /octo surface is enabled

`/octo` is a **native chat slash command**, not a plugin. It is registered in the command registry at:

- `src/auto-reply/commands-registry.shared.ts:828` — `defineChatCommand({ key: "octo", ... })`
- `src/auto-reply/reply/commands-octo.ts` — the handler
- `src/auto-reply/reply/commands-handlers.runtime.ts` — wired into `loadCommandHandlers()`

`plugins.allow` in `openclaw.json` governs third-party plugin packages. It has **nothing** to do with native commands like `/octo`, `/acp`, `/help`, `/status`, `/whoami`, etc. Those are always registered when the gateway boots and their handlers run unconditionally (gated only by `isAuthorizedSender` and per-command scope checks).

The only config flag that actually gates Octo is:

```json
{ "octo": { "enabled": true } }
```

This is currently set in `~/.openclaw/openclaw.json`. On gateway startup you should see:

```
octopus orchestrator: enabled=true
[octo:init] node agent started: ...
[octo:init] Octopus Orchestrator initialized successfully
```

in `/tmp/openclaw/openclaw-YYYY-MM-DD.log`. Grep for `orchestrator:` to confirm.

## What was just shipped (commits to look at)

```
git log --oneline -10 src/octo src/auto-reply/reply/commands-octo.ts
```

Top commits as of 2026-04-12:

- `16147f3f6c` — /octo mutating actions (mission abort/pause/resume, arm terminate) with `--yes` confirm gate; RemotePtyTmuxAdapter PATH fix; codex `--skip-git-repo-check`; tests (classify-failure, elo, commands-octo — 39 cases)
- `01bd20644c` — chat handler wiring, remote sentinel polling root-cause fix, durable artifact storage, Elo persistence, auth-failure classification, per-node concurrent arm cap
- `085252c77d` — remove duplicate `/octo` slash command registration
- `1ba17ef78c` — register `/octo` slash command in chat registry
- `b8ff8809dd` — NodeAgent remote sentinel polling for distributed arms

## How to pressure test

### 1. Verify the runtime is really running what this tree builds

```bash
cd /Users/michaelmartoccia/clawd/openclaw_repo-octopus
ls -la $(which openclaw)
openclaw gateway status
grep "orchestrator:" /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | tail -3
```

Expect: symlink into this tree, `Runtime: running`, `RPC probe: ok`, and a recent `enabled=true` line.

### 2. Quick read-only probes from chat

On the internal channel with `operator.admin` scope:

```
/octo help
/octo status
/octo doctor
/octo mission list
/octo arm list
/octo grip list
/octo elo
```

Expected:

- `help` → usage text listing read-only and mutating actions
- `status` → dashboard counts (may show zero of everything on a fresh DB)
- `doctor` → health checks (sqlite, event log, tmux, feature flag)
- the list commands → empty results or existing entities
- `elo` → `"No Elo ratings yet"` on a fresh registry

If you get `"Octopus Orchestrator is not enabled on this gateway"`, it means `initOctopus` failed silently. Tail the log for the actual error and report it.

### 3. End-to-end local-only competitive test

From the CLI (mission create has too many params for a chat one-liner):

```bash
openclaw octo mission create \
  --title "haiku-test" \
  --owner me \
  --grip-id t1 \
  --idempotency-key "test-$(date +%s)" \
  --execution-mode competitive \
  --arm-template claude \
  --arm-template codex \
  --arm-template gemini \
  --prompt "write a haiku about octopi"
```

Then watch:

```bash
openclaw octo events tail     # live event stream
openclaw octo status           # dashboard
openclaw octo mission list
openclaw octo mission show <mission_id>
/octo elo                      # after completion, ratings populate
```

Expected flow:

1. Mission `mis_...` created, 7 grips auto-expanded (3 work + 3 judge + 1 verdict)
2. 3 work arms spawn in parallel (claude/codex/gemini)
3. Each completes → sentinel file + output artifact persisted
4. Phase cascade auto-spawns 3 judge arms, then 1 verdict arm
5. Mission transitions to `completed`, `_output_artifact` points into `~/.openclaw/octo/artifacts/<mission_id>/`
6. Elo game recorded — `/octo elo` shows non-zero ratings

### 4. Distributed test (after verifying 3)

```bash
openclaw octo mission create \
  --title "haiku-distributed" --owner me --grip-id t1 \
  --idempotency-key "dist-$(date +%s)" \
  --execution-mode competitive \
  --arm-template claude --arm-template codex --arm-template gemini \
  --target-node codex=distiller-rpi5 \
  --prompt "write a haiku about octopi"
```

`codex` will run via SSH+tmux on 192.168.1.71 (RPi5), the other two stay local. `claude` and `gemini` stay local because `--target-node` only maps the runtimes you specify.

**Known blocker for the distributed run**: codex and gemini on .71 have expired auth tokens (confirmed 2026-04-12). Claude on .71 is "Invalid API key — please run /login". Arms will now surface as `reason: auth_required` in the event payload (new classification shipped today) instead of a generic `exit_code_1`. Resolution requires interactive re-login on .71:

```bash
sshpass -p 'Distiller' ssh distiller@192.168.1.71
claude /login        # interactive
codex login          # interactive
gemini               # OAuth browser flow
```

### 5. Mutating chat actions (with confirm gate)

```
/octo mission pause <mission_id>
  → preview, no mutation

/octo mission pause <mission_id> --yes
  → executes, calls octo.services.handlers.missionPause

/octo arm terminate <arm_id> --yes
  → executes, calls octo.services.handlers.armTerminate
```

Without `--yes`, the handler prints a preview (title, status, live arm count) and refuses. This is the approval gate — single-turn stateless, no `ApprovalRequest` state machine.

## Files to look at if something goes wrong

| Symptom                                                     | Look at                                                                                                                                                                    |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/octo` returns `"not enabled"`                             | `grep "orchestrator:" /tmp/openclaw/openclaw-*.log` — init error                                                                                                           |
| `/octo` returns `"not_implemented"`                         | Handler not wired — check `commands-handlers.runtime.ts` has `handleOctoCommand`                                                                                           |
| `/octo` returns `"unknown chat command"`                    | Duplicate registration (see `085252c77d`) or build not deployed — `ls -la $(which openclaw)` + re-run `pnpm build` + `cp src/octo/head/storage/schema.sql dist/schema.sql` |
| Mission stuck in `active` forever                           | Grip not completing — `openclaw octo events tail` + check arm state transitions                                                                                            |
| Remote arm stuck in `starting`                              | Was the bug fixed in commit `01bd20644c`. If it recurs, check `NodeAgent.start()` isn't calling `watchArm()` on arms with `spec.labels.target_node`                        |
| Arm fails with `session_terminated_no_sentinel` immediately | Same bug as above — remote arm being watched by local ProcessWatcher                                                                                                       |
| Codex fails with `trusted directory`                        | Runtime profile should pass `--skip-git-repo-check` (fixed in `16147f3f6c`)                                                                                                |

## Architecture quick-reference

```
chat /octo            → commands-octo.ts        → getOctoRuntimeInstance() → octo.services.*
openclaw octo CLI     → src/octo/cli/register.ts → same services via direct construction (or fallback JSON-RPC)
octo.arm.spawn WS     → gateway-handlers.armSpawn → adapter.spawn → tmux session + sentinel
tmux session exits    → ProcessWatcher (local) OR NodeAgent step 4 SSH poll (remote)
                      → arm.completed / arm.failed event
                      → phase cascade (auto-spawn next phase arms)
                      → mission.completed event
                      → artifact copy to ~/.openclaw/octo/artifacts/<mission>/
                      → EloService.recordGame (if verdict JSON parses)
```

---

**Bottom line:** this directory is the live build. `/octo` is a native command, not a plugin. Stop looking for a second workspace. Start by running `/octo status` in chat or `openclaw octo status` on the CLI — those are your first two probes.
