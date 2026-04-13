# RFC Issue — Agent Teleconference Protocol

**Target:** new issue on https://github.com/openclaw/openclaw/issues
**Suggested title:** `[RFC] Agent Teleconference — minimum-viable scoped meeting primitive with working prototype`
**Suggested labels:** `rfc`, `multi-agent`, `proposal`, `needs-triage`
**Posting:** after the four comments (01-04) have been live for ≥24 hours
**Tone:** concrete, evidence-forward, explicitly dependent on prior art, minimum surface area

---

## Title

[RFC] Agent Teleconference — minimum-viable scoped meeting primitive with working prototype

## Summary

This RFC proposes an **agent teleconference** primitive: a scoped,
multi-turn, human-observable conversation between two or more agents
with explicit lifecycle (dial → pickup → exchange → wrap) and a
durable transcript artifact.

The entire primitive is implementable on top of **existing openclaw
primitives** — `openclaw agent --to --deliver`, session persistence
per `chat_id`, channel plugins — with approximately 800-1200 LOC of
new TypeScript wrapping them into explicit verbs.

A working prototype exists as shell scripts and was used to
diagnose + fix a real bug ([commit `fb24c1f3d7`](https://github.com/mmartoccia/openclaw/commit/fb24c1f3d7))
as its first production exercise. Evidence is not synthetic.

This RFC **explicitly depends on** and composes with existing work:

- #51642 — Conference/Multi-Agent Sessions (closest prior art on
  lifecycle semantics)
- #63789 — Proposal: minimal agent-to-agent handoff protocol (closest
  philosophical alignment on the transport contract)
- #35203 — RFC: Multi-Agent Collaboration Enhancement (the bigger
  architectural vision this is an on-ramp to)
- #62581 — Internal agent-to-agent messaging (direct scope overlap)
- #40325 — Supervised Agent-to-Agent Collaboration Sessions (same
  safety principle)

Intent: **converge the conversation** rather than add a 16th
competing proposal.

## Motivation

openclaw has at least 15 open issues and 2 active PRs on agent-to-agent
communication as of 2026-04-12, covering a spectrum from full Google
A2A protocol adoption (#60502) to minimal handoff contracts (#63789)
to full architectural RFCs (#35203). None of them have converged,
none have maintainer endorsement, and the one actively reviewed PR
(#60502) is stuck in automated-code-review limbo.

Meanwhile, operators running multi-agent setups today are hitting
this gap constantly. The "copy-paste alt-tab" problem — where the
human manually relays messages between two agents' chat surfaces to
resolve a question — is a symptom that grows more painful with each
additional agent, each additional channel, each additional workspace.

The primitive that solves this is small. Most existing primitives
needed to build it already exist:

- **Addressing** — `openclaw agent --to <chat_id>` routes by chat, not by
  agent id, which is enough because chat ids are unique per agent DM
- **Transport** — `--deliver` posts both the injected prompt and the
  reply back to the channel, producing a visible two-sided
  conversation without any new protocol work
- **Session continuity** — per-chat_id session store already
  accumulates turns correctly for multi-turn exchanges
- **Cross-channel markdown** — classic Markdown parse mode is the
  telegram plugin default, renders `*bold*`, `` `code` ``, triple-
  backtick blocks, emojis directly

What's _missing_ is:

1. An explicit **lifecycle** — meetings have a beginning, middle, and
   end, with a transcript artifact that survives
2. A **dial** primitive — one agent can request a meeting with
   another agent in a different process without the target agent
   needing a listening socket
3. **Visible frames** — opening / speaker-turn / reply / wrap frames
   so human observers can follow which agent is saying what
4. **Named verbs** — so operators can `openclaw agent teleconference
dial` without knowing the incantation of `agent --to --deliver`

All four are thin layers over existing primitives.

## Evidence (not hypothetical)

I prototyped this primitive over the course of a single afternoon
(2026-04-12) as shell scripts. The prototype was used the same day
to diagnose and fix a real bug — [`openclaw octo doctor`](https://github.com/mmartoccia/openclaw/commit/fb24c1f3d7)
was silently reporting `feature-flag: octo enabled=false` regardless
of the user's config because `checkFeatureFlag()` was calling
`loadOctoConfig({})` with an empty object literal and getting back
the schema default.

**Meeting transcript** (reconstructed from actual Telegram exchange):

- **Turn 1** (Claude Code session → openclaw main agent): _"Here are
  three questions: (1) exact doctor output, (2) when you ran it
  relative to the last gateway restart, (3) shell or chat invocation.
  Goal: rule out stale cache vs. real bug."_
- **Turn 2** (openclaw main → Claude Code): exact doctor output
  showing `[OK] feature-flag: octo enabled=false`, confirming
  post-restart, from shell
- **Diagnosis** (Claude Code, locally): read `src/octo/cli/doctor.ts`,
  identified the `loadOctoConfig({})` call as the bug
- **Fix** (Claude Code, locally): rewrote `checkFeatureFlag()` to
  read `~/.openclaw/openclaw.json` from disk, upgraded severity so
  `enabled=false` now reports `[WARN]` with a detail line
- **Turn 3** (Claude Code → openclaw main): _"Bug found. Root cause
  in doctor.ts:49. Fix landed as commit `fb24c1f3d7`. Can you verify
  on your side?"_
- **Turn 4** (openclaw main → Claude Code): confirmed, post-restart
  doctor output now shows `[OK] feature-flag: octo enabled=true`

**Total elapsed time:** ~5 minutes of live exchange, no human
relaying. Both sides had independent session contexts. The
human (operator) watched the whole thing happen in Telegram.

**Second meeting — proving bidirectional dial:** after shipping the
fix, I extended the prototype to let the remote agent initiate a
meeting back, via a file-inbox primitive at
`~/.openclaw/meetings/pending/`. The openclaw main agent successfully
executed `meet-dial.sh --to claude-code --topic "dial protocol
onboarding test"`, the pending file landed, the Claude Code session
picked it up, moved it to `active/`, responded via `reply_via:
telegram:1234567890` (captured from the dial request), ran one
exchange, and moved the file to `closed/` on wrap. Bidirectional
round-trip proven end-to-end.

## Proposed primitive

### New CLI surface

```bash
# Dial a meeting (optionally with a specific starting message)
openclaw agent teleconference dial \
  --to <agent-id | chat-id> \
  --topic "<short topic>" \
  [--context "<longer context>"] \
  [--channel <channel>] \
  [--message "<optional first message>"]

# Pick up a pending meeting addressed to this agent
openclaw agent teleconference pickup \
  --meeting <meeting_id>

# Send a turn within an active meeting
openclaw agent teleconference send \
  --meeting <meeting_id> \
  --message "<text>"

# Wrap a meeting with an outcome
openclaw agent teleconference wrap \
  --meeting <meeting_id> \
  --outcome "<one-line summary>"

# Query meetings
openclaw agent teleconference list \
  [--state pending|active|closed|all] \
  [--to <agent>]

openclaw agent teleconference show \
  --meeting <meeting_id>

openclaw agent teleconference transcript \
  --meeting <meeting_id>
```

### Meeting file format

```json
{
  "meeting_id": "mtg_01HXXXX",
  "from_agent": "openclaw-main",
  "from_channel": "telegram",
  "from_chat_id": "1234567890",
  "to_agent": "claude-code",
  "topic": "remote sentinel polling under load",
  "context": "optional longer context",
  "reply_via": "telegram:1234567890",
  "created_at": "2026-04-12T13:57:40Z",
  "started_at": "2026-04-12T13:58:12Z",
  "ended_at": "2026-04-12T14:03:01Z",
  "picked_up_by": "claude-code-session-1",
  "outcome": "✅ Root cause identified, fix shipped as commit abc123",
  "turns": 4,
  "status": "closed"
}
```

Lifecycle states are **directories**, not fields:

- `~/.openclaw/meetings/pending/<meeting_id>.json` — waiting for pickup
- `~/.openclaw/meetings/active/<meeting_id>.json` — in progress
- `~/.openclaw/meetings/closed/<meeting_id>.json` — terminal state

Transitions are atomic file moves. No locks, no race conditions, any
session can pick up pending work, and the directory listing _is_ the
state query. The `closed/` directory is an append-only ledger.

### Visual protocol (Telegram output)

Classic Telegram Markdown, emojis, unicode separators. No parse_mode
negotiation needed.

**Meeting open:**

```
🎤 *MEETING OPENED*
━━━━━━━━━━━━━━━━━━━━━
*Topic:* <topic>
*Participants:* 🤖 <initiator> ↔ 🦾 <callee>
*Meeting ID:* `mtg_...`
━━━━━━━━━━━━━━━━━━━━━
```

**Speaker turn:**

```
🤖 → 🦾 *<speaker> → <listener>*
━━━━━━━━━━━━━━━━━━━━━
<message body — Markdown allowed>
━━━━━━━━━━━━━━━━━━━━━
```

**Meeting wrap:**

```
🔚 *MEETING WRAPPED*
━━━━━━━━━━━━━━━━━━━━━
*Duration:* N turns
*Outcome:* <one-line summary>
*Artifacts:* <commits, files, follow-ups>
━━━━━━━━━━━━━━━━━━━━━
```

Emoji assignments are configurable per-agent via a new optional
`agents.<id>.icon` field in `openclaw.json`.

## Scope discipline

**In scope for this RFC (Phase 1):**

- The seven verbs above (`dial / pickup / send / wrap / list / show
/ transcript`)
- Meeting file format + directory lifecycle
- Visual frames in classic Markdown
- Meeting file persistence at `~/.openclaw/meetings/`
- Integration with existing `openclaw agent --to --deliver` path (no
  new channel plugin work)
- Skill auto-registration so agents auto-discover the capability
- Tests + docs at `docs/cli/agent-teleconference.md`

**Explicitly deferred (later phases, in order of priority):**

1. **Phase 2 — Search + query** — `openclaw meetings search "<query>"`
   over the closed-meeting corpus. Minimum viable Layer 2 of #35203.
2. **Phase 3 — Capability profiling + matchmaker** — per-agent
   reputation from meeting outcomes, combined with Octo's ELO for
   task-solving. Feeds a "suggest participants for topic X" router.
   Minimum viable Layer 1 of #35203.
3. **Phase 4 — Layered memory** — visibility tiers (private / team /
   global), permission gates. Minimum viable Layer 3 of #35203.
4. **Phase 5 — Token budget integration** — per-meeting cost
   tracking, daily/weekly caps, overrun detection. Minimum viable
   Layer 4 of #35203.
5. **Autonomous dial** — agents can initiate meetings themselves
   when confidence is low or blocked. Needs safety guardrails
   (max-depth, budget gates, bot-loop detection per #58789).
6. **Multi-party fan-out** — ≥3 participants in a single meeting.
   The 1:1 case is enough to learn from first.
7. **Chat slash command** — `/meet dial @agent topic` — CLI-only
   for MVP.

**Out of scope permanently (will not build in this track):**

- Full workflow engine / retries / dashboards / DB-backed
  orchestration (intentionally matching #63789's scope discipline)
- Cross-instance / cross-org discovery (that's closer to #28106's
  agent economy vision; we don't need it to solve the operator
  problem today)
- External JSON-RPC interop (covered by #60502; this RFC is about
  the native primitive that sits under it)

## Relationship to existing proposals

| Proposal                                       | Relationship                                                 | Action                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| #51642 (Conference/Multi-Agent Sessions)       | **Closest prior art on lifecycle**                           | Folds the core idea into a concrete implementation; credits the proposal in code + docs                           |
| #63789 (minimal handoff protocol draft PR)     | **Closest philosophical alignment on transport contract**    | RFC depends on this PR landing first; meeting layer composes with whatever `handoff_id` + ack shape it settles on |
| #35203 (Multi-Agent Collaboration Enhancement) | **Big architectural vision we'd provide on-ramp for**        | RFC's Phases 2-5 deliver minimum-viable versions of its four layers                                               |
| #62581 (internal agent-to-agent messaging)     | **Same kernel, narrower scope**                              | Folded in as the same-gateway fast-path transport case                                                            |
| #40325 (supervised collaboration sessions)     | **Same safety principle; had POC plugin blocked by API gap** | CLI-layer approach sidesteps the plugin-runtime API gap they hit                                                  |
| #60502 (Google A2A protocol PR)                | **External interop, complementary**                          | Would benefit from a clean internal primitive to sit underneath                                                   |
| #6842, #12401, #10486                          | Earlier A2A proposals (closed / stale)                       | Acknowledged as prior art in the historical section                                                               |
| #28106 (Agent Economy RFC)                     | Much larger vision, different problem                        | Acknowledged but not depended on                                                                                  |
| #55168 (LCP RFC)                               | Competing transport standard                                 | Not depended on — we'd reuse existing openclaw channel plugins rather than introduce LCP as a transport           |

## Open design questions

1. **Layering with #63789's handoff contract.** Should meetings
   live **above** the handoff layer (meetings compose handoffs),
   **inside** it (meetings are a kind of handoff with lifecycle),
   or **alongside** it (parallel primitives for different use
   cases)? The RFC as written assumes "above," but I'm open to
   alternatives and will adjust to whatever #63789 lands as.
2. **Same-gateway fast path.** Should the MVP implement the
   file-inbox transport only (simpler, works cross-process), or
   dual-implement a same-gateway in-memory fast path for
   performance? My current instinct: file-inbox only for Phase 1,
   add fast path in Phase 1.5 if measurement shows it matters.
3. **Session store integration.** Meetings as session records
   (`session.kind = "meeting"` in existing SQLite store) or
   separate sidecar (JSON files in `~/.openclaw/meetings/`)?
   Prototype uses sidecar; production shape TBD.
4. **Multi-party participants.** 1:1 only for Phase 1, or design
   the file format + verbs to accommodate N-party from day one
   even if the MVP only exercises 1:1? Leaning toward "design for
   N, ship 1:1 only" so we don't rewrite the format later.
5. **Agent skill wiring.** How do we ensure agents know about the
   teleconference verbs without needing manual IDENTITY.md edits
   per-agent? Candidate: auto-register as a core skill so every
   agent sees it in its tool catalog. Needs review of current
   skill-registration pathway.

## Working prototype artifacts

All of the following are in a fork branch at
[`mmartoccia/openclaw#octopus-orchestrator-clean`](https://github.com/mmartoccia/openclaw/tree/octopus-orchestrator-clean):

- **Concept documents:**
  - `docs/octopus-orchestrator/AGENT-TELECONFERENCE.md` — primitive
    design
  - `docs/octopus-orchestrator/TELECONFERENCE-DIAL.md` — bidirectional
    dial layer design
- **Runnable prototype:**
  - `scripts/teleconference/meet-dial.sh` — dial a meeting, write to
    pending/, optional macOS notification
  - `scripts/teleconference/meet-check.sh` — list meetings by state
- **First production use:** [commit `fb24c1f3d7`](https://github.com/mmartoccia/openclaw/commit/fb24c1f3d7) — fix(octo): doctor feature-flag check reads real config instead of defaults

## What I'd like from maintainers

1. **Direction check.** Is the minimum-viable meeting primitive,
   composing with existing primitives and landing as CLI verbs, an
   acceptable direction? Or is the roadmap going elsewhere (e.g.,
   toward #60502's Google A2A as the primary transport, or #35203's
   larger architectural RFC as the preferred landing shape)?
2. **Go/no-go on Phase 1.** If the direction is acceptable, I'll
   file a formal PR implementing the seven verbs + tests + docs,
   targeting roughly 800-1200 LOC of new TypeScript. Timeline: 1-2
   weeks of focused work.
3. **Coordination with #63789.** If the handoff protocol proposal
   there is moving forward, how do you want these two pieces to
   compose? I'm willing to let it land first and adjust my layer to
   it, or to land alongside if they're truly orthogonal.
4. **Labeling.** Appropriate labels for this RFC so it's triaged
   correctly. I've self-applied `rfc`, `multi-agent`, `proposal`,
   `needs-triage` but defer to your taxonomy.

## If this RFC stalls

Historical precedent (see #35203, #51642, #28106, #55168 — all good
RFCs with zero maintainer response after weeks or months) suggests
this RFC may also stall. If that happens, my plan is:

- Wait 1 week for any response
- If no response, file the Phase 1 PR directly with working code
  and cross-link this RFC for context — "code speaks louder than RFC"
  is supported by the commit history of openclaw's recent feature
  landings
- If that also stalls, the prototype lives in my fork indefinitely
  and is available for anyone else who wants to pick up or fork
  the design

I'd much rather land this upstream and collaborate than maintain a
fork — but I'm committed to making this primitive work one way or
another because the operator problem it solves is real and growing
with every new multi-agent setup I build.
