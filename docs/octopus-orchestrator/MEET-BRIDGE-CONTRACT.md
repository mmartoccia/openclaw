# Meet Bridge Contract

**Status:** frozen 2026-04-12
**Supersedes nothing; extends:** `TELECONFERENCE-DIAL.md`, `AGENT-TELECONFERENCE.md`
**Owning code:** `src/commands/meet.ts`, `src/cli/program/register.meet.ts`
**Owning test:** `src/commands/meet.test.ts`, `openclaw meet doctor` verb
**Referenced commits:** `28b0223194`, `a4f5a1fe54`

## Why this doc exists

The meet bridge silently drifted into a degraded state on 2026-04-12 and
we spent several hours rediagnosing it. The substrate code had not
changed since the original PR, but runtime behavior had. Two separate
failures compounded:

1. The body-post half of `agent --deliver` stopped echoing the input
   to the channel. Replies still worked, so the bridge looked
   functional until it became obvious only one side of each turn was
   visible in Telegram.
2. The local agent's framed replies were attributed to a "remote"
   openclaw-main entity that didn't actually exist. All "openclaw-main"
   responses came from the local `main` agent running gpt-5.4 in its
   own session. When the attribution got muddied, the debugging path
   chased the wrong layers.

This document freezes the bridge contract explicitly so drift is
detectable in seconds, not hours, and attribution is unambiguous.

## Source of truth

### Meeting state lives in the filesystem

Only these three directories define meeting state:

- `~/.openclaw/meetings/pending/`
- `~/.openclaw/meetings/active/`
- `~/.openclaw/meetings/closed/`

If a meeting JSON is not in one of those three directories, the meeting
is not in any defined state. Telegram messages, chat history, and agent
session logs are **not** sources of truth for meeting state.

### Lifecycle transitions are file moves, never edits

| Transition | Effected by                                | Fields added                                     |
| ---------- | ------------------------------------------ | ------------------------------------------------ |
| create     | `meet dial` → `pending/`                   | `created_at`, `status: "pending"`                |
| pickup     | `meet pickup` moves `pending/` → `active/` | `started_at`, `picked_up_by`, `status: "active"` |
| wrap       | `meet wrap` moves `active/` → `closed/`    | `ended_at`, `outcome`, `status: "closed"`        |

Transitions MUST be atomic file renames (`renameSync`). Editing a
file in place to change its state is forbidden — tools that glob by
directory would see a lying `status` field.

### Transport is Telegram (or any channel), not state

Telegram is a **delivery surface**. It carries meeting content to the
operator. It is **never** the state machine. A message that reached a
Telegram thread does not advance a meeting's state; only a file move
under `~/.openclaw/meetings/` advances state.

## Relay primitives

### Allowed paths for relaying content to a chat

Only two paths are legitimate for getting content into a chat surface:

1. **`openclaw message send`** — literal relay, posts the given text
   verbatim to the channel. Use for any machine-authored content that
   should appear exactly as written.
2. **`openclaw meet send` (which wraps the above + agent inference)**
   — the only legitimate primitive for a meeting turn. Internally it
   orchestrates body post + agent inference + reply reframe (see below).

### Forbidden paths

- **`openclaw agent --to X --deliver`** for literal relay. This runs
  an agent turn whose output is whatever the model decides to generate,
  not the literal text the caller passed. It is fine for invoking an
  agent but it is not a relay primitive. Using it for relay muddies
  attribution (the local gpt-5.4 agent generates a reply, which then
  looks like it came from "the other side" when it actually came from
  this machine).
- **Hand-crafted HTTP to Telegram** or any direct channel API call
  that bypasses the gateway. Always go through `openclaw`.

## meet send turn flow (3 explicit steps)

For every turn, `meet send` performs exactly three operations in order:

### STEP 1 — Post the framed body

```text
openclaw message send \
  --target <chatId> \
  --channel <channel> \
  --message "<speakerFrame(from, to, body, fromIcon, toIcon)>"
```

Result: the body appears in the channel with the speaker frame
prefix `fromIcon *from* → toIcon *to*`. Operators see who is speaking
at a glance.

Best-effort: if this step fails, the turn proceeds to STEP 2 but the
body will not be visible in the channel. The body is always captured
in the meeting JSON transcript regardless.

### STEP 2 — Run the agent WITHOUT `--deliver`

```text
openclaw agent \
  --to <chatId> \
  --channel <channel> \
  --json \
  --timeout 180 \
  --message "<same framed body>"
```

**Critical: `--deliver` is deliberately omitted.** With `--deliver`
dropped, the agent runs the inference, captures the reply in
`result.meta.finalAssistantVisibleText`, and does **not** auto-post
anything to the channel. STEP 3 posts the reply explicitly with the
correct framing.

Why not `--deliver`? Historically the PR claimed "agent --deliver
posts BOTH the prompt and the reply to the channel." That was
literally true at one point but silently regressed. Even when it
worked, the reply was posted as bare text without a speaker frame,
breaking visual symmetry. Dropping `--deliver` and reposting
explicitly via STEP 3 is robust to any input-echo drift in
`--deliver`'s internal path and guarantees symmetric framing.

### STEP 3 — Post the framed reply with reversed direction

```text
openclaw message send \
  --target <chatId> \
  --channel <channel> \
  --message "<speakerFrame(to, from, reply, toIcon, fromIcon)>"
```

Notice the arguments: the direction is reversed (`to, from` instead of
`from, to`) and the icons are swapped (`toIcon, fromIcon`). So for a
turn where claude-code speaks to openclaw-main, the body frame shows
`🦾 claude-code → 🦀 openclaw-main` and the reply frame shows
`🦀 openclaw-main → 🦾 claude-code`. Both halves visually symmetric
and unambiguously attributed.

Best-effort: if the reply reframe fails, the reply is still captured
in the meeting JSON transcript and the agent session log, so no data
is lost — only the symmetric Telegram visibility is missed.

## Per-agent icon registry

Each agent identity has a stable, visually distinct icon so two
adjacent turns from different agents are never visually confused.

| Agent id                            | Icon | Meaning                            |
| ----------------------------------- | ---- | ---------------------------------- |
| `claude-code`, `claude`             | 🦾   | claw (Claude)                      |
| `openclaw-main`, `openclaw`, `main` | 🦀   | crab (openclaw mascot)             |
| `meet-doctor`                       | 🩺   | stethoscope (smoke-test initiator) |
| `meet-doctor-target`                | ⚕️   | medical (smoke-test target)        |
| anything else                       | 🤖   | fallback                           |

Add new icons to `AGENT_ICONS` in `src/commands/meet.ts` when
introducing a new agent identity. Keep them visually distinct — the
whole point is that two adjacent bubbles from different agents are
instantly distinguishable without reading the names.

## Smoke test: `openclaw meet doctor`

A dedicated CLI verb runs the full lifecycle with a sentinel body and
reports which specific step fails if the bridge drifts. Run it:

- **On demand:** when comms feel off, before assuming anything is
  broken.
- **After every gateway restart:** fresh dist may change routing; the
  doctor confirms the bridge is healthy in seconds.
- **Before declaring a meet protocol change "working":** if you
  change any of the three steps above, the doctor must still pass.

Two modes:

### Local-only mode

```bash
openclaw meet doctor
```

Verifies the filesystem state machine (dial → pickup → wrap) without
touching any channel. Safe to run anywhere, no external side effects.
Catches filesystem permission problems, path-resolution bugs, and
lifecycle transition bugs.

### Channel mode

```bash
openclaw meet doctor --channel telegram --target <chat_id>
```

Additionally runs a real meet send turn through the given channel,
verifies both body and reply are captured in the meeting transcript,
wraps cleanly. This is the test that would have caught the 2026-04-12
body-post regression within seconds of drift.

### Named checks

| Check                         | Fails when                                    |
| ----------------------------- | --------------------------------------------- |
| `meet_dirs_writable`          | cannot create pending/active/closed dirs      |
| `dial_creates_pending`        | dial did not write a pending JSON file        |
| `pickup_moves_to_active`      | atomic move from pending to active failed     |
| `send_executes`               | `meet send` threw or returned no result       |
| `body_captured_in_transcript` | sentinel body not in meeting JSON transcript  |
| `reply_captured`              | agent returned empty reply — inference broken |
| `wrap_moves_to_closed`        | atomic move from active to closed failed      |

The whole point of named checks is that when something breaks, the
operator does not have to reason about which layer is at fault. The
failing check's name tells them.

## Attribution rules

### What is a "real" openclaw-main message

The `main` agent is a **local** gpt-5.4 inference loop living at
`~/.openclaw/agents/main/sessions/<session_id>.jsonl`. It is not a
remote entity. It is not a separate machine. It is not a human.
There is only one gpt-5.4 inference runtime on the Mac, and both
`claude-code`-initiated calls (via `openclaw agent --to X`) and
Telegram-inbound-triggered calls go through the same `main` agent.

When a message appears in the chat with the `🦀 openclaw-main → ...`
frame, it was authored by the local `main` agent's inference loop in
response to context in its session. That context may include:

- The framed body that `meet send` STEP 1 just posted
- Prior turns from the same meeting
- Mike's direct Telegram messages (ingested as user messages)

### What is NOT a "real" openclaw-main message

- Anything `claude-code` sent via `openclaw message send` — that is
  `claude-code` authorship, relayed verbatim. Even if it contains
  the phrase "from openclaw-main" or speaks in that persona, it's
  not from main.
- Anything generated by an agent roleplay that just happens to use
  the `[openclaw→claude-code]` prefix in its content. Framing text
  is not attribution.
- Anything that would have gone through `agent --deliver` if the
  wrapper had run. The wrapper is the authority on attribution.

### When in doubt

Check `main`'s session log directly:

```bash
ls -lt ~/.openclaw/agents/main/sessions/*.jsonl | head
```

The most-recently-modified session is the one currently active for
whichever chat main is handling. Its `assistant`-role entries are
the authoritative record of what main has actually said.

## Durability playbook

### When the bridge feels off

1. Run `openclaw meet doctor --channel telegram --target <chat_id>`
2. Read the named checks. The first failing one is the layer to
   investigate.
3. If all checks pass but you're still seeing weird behavior, the
   problem is in attribution, not delivery. Check `main`'s session
   log to see what main has actually been saying vs what you thought.

### After a gateway restart

Any gateway restart can change internal routing state. Re-run the
doctor in channel mode before assuming the bridge is healthy. The
smoke test takes under 10 seconds.

### After editing meet.ts

1. `pnpm test src/commands/meet.test.ts` must pass (25/25)
2. `pnpm build` must be green
3. Restart the gateway
4. Run `openclaw meet doctor --channel telegram --target <your_chat>`
   with full checks passing
5. Send one real meet send turn and visually confirm both halves
   appear in the channel with symmetric framing

### When adding a new agent identity

1. Add an entry to `AGENT_ICONS` in `src/commands/meet.ts` with a
   visually distinct icon
2. Update the registry section of this document with the new mapping
3. Confirm existing tests still pass (the registry is opt-in; default
   fallback is 🤖)

## Historical debugging notes (do not repeat these)

- **Do not chase the regression in `agent --deliver`'s input-echo
  path.** Zero source commits between the PR and the regression;
  it's runtime state, not code. The meet wrapper bypasses the
  problematic path entirely by using `message send` for both halves.
- **Do not treat Telegram messages as state.** Meeting state is
  files. Telegram is delivery.
- **Do not assume `[openclaw→claude-code]`-framed content is from a
  remote entity.** The framing is text generated by the local agent.
  There is no remote entity.
- **Do not substitute `openclaw message send` for `meet send` as a
  shortcut.** Raw `message send` posts the literal text with no
  framing, no agent inference, no transcript capture, no meeting
  state advancement. It is a relay primitive, not a meeting turn.

## What is out of scope for this doc

- Cross-machine meet protocols. The current bridge assumes both
  sides are on the same Mac sharing `~/.openclaw/meetings/`. Cross-
  machine support needs either a shared filesystem, a sync daemon,
  or a structured-Telegram-transport shim (option (b) from the
  2026-04-12 bridge contract discussion with main). None of those
  exist yet.
- ACK back to the dialer. When claude-code picks up a dial,
  openclaw-main has no current way to know. The original PR listed
  this as future work; it remains future work.
- Meeting retention / cleanup. `closed/` grows forever. Needs a
  `meet prune` verb or a cron-style retention policy.
