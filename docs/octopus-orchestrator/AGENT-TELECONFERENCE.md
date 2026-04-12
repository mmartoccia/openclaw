# Agent Teleconferencing — Ad-Hoc Multi-Agent Meeting Mode

**Status:** concept / pre-PR (2026-04-12)
**Origin:** debugging the `/octo` surface misunderstanding between the Claude Code session in `openclaw_repo-octopus` and the OpenClaw `main` agent via Michael's telegram DM. Proved the raw mechanics work; this doc scopes the PR that wraps them into a first-class verb.

## Motivation

When two agents have different pictures of the same system (e.g., one thinks `/octo` is disabled because `plugins.allow` excludes it; the other knows `/octo` is a native chat command and `plugins.allow` is irrelevant), the current workflow requires the human to manually copy-paste messages between agents' chat surfaces. That's the "alt-tab interface" problem:

- User opens Agent A → pastes question
- User opens Agent B → pastes A's answer as context → pastes question
- User opens Agent A → pastes B's reply → pastes follow-up
- Repeats until resolution

The human metaphor is a **teleconference**: _"I've got a developer working on something, and you and I are chatting about a few things — we want to teleconference the developer in for a mini-meeting to discuss more."_ Ad hoc, scoped, bidirectional, ends when the question is resolved. Three key properties:

1. **Ad hoc** — no permanent dedicated agent required, spun up on demand
2. **Multi-turn** — not a single question/answer injection, a real back-and-forth
3. **Visible to the user** — the human sees both sides of the conversation live, can interject, redirect, or end

## What we proved today

All primitives already exist in `openclaw`:

- `openclaw agent --to <chat> --channel <channel> --message <text>` runs one agent turn with the message injected as user input. Returns the response in stdout.
- `--deliver` flag posts **both the prompt and the reply** back to the channel, producing a visible two-sided conversation in the user's chat.
- Session history is persisted per `chat_id`, so repeated calls accumulate as a multi-turn thread rather than isolated one-shots.
- Classic Telegram Markdown (`*bold*`, `` `code` ``, triple-backtick blocks), emojis, and unicode separators all render in the DM.

**First meeting successfully conducted** using these primitives:

- Topic: the `openclaw octo doctor` feature-flag bug
- Turns: 2 (questions → diagnosis → confirmation)
- Outcome: root cause identified at `src/octo/cli/doctor.ts:47-62`, fix shipped as commit `fb24c1f3d7`, both sides verified

## Current rough edges

These are workable-around today but should get cleaned up in the PR:

| Issue                                                                | Current workaround                                                 | PR fix                                                                         |
| -------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Telegram `message read` not supported — can't poll for replies       | Use `agent --to` instead; reply comes back in stdout synchronously | Wrap the pattern in a single verb so callers don't have to know the difference |
| No session isolation — meeting traffic mingles with normal agent DMs | Accept the noise for now                                           | Allow `--session-id` scoping or create ephemeral meeting session ids           |
| No meeting lifecycle — no "start" / "end" markers                    | Protocol convention (opening/closing emoji frames)                 | Wire into OpenClaw session lifecycle so it's queryable and auditable           |
| No participant addressing — only supports 1:1, not 3-way             | Sequence calls: me → A, then me → B with A's reply as context      | Add a `--with <agent-id>` multi-target mode that fans out / synthesizes        |
| `openclaw agent` takes 30+ seconds per turn (cold model call)        | Live with it                                                       | Out of scope — that's inference latency, not the meeting layer                 |

## Proposed PR: `openclaw agent teleconference`

Add a new verb that wraps the `agent --to --deliver` pattern with teleconference semantics.

### Command surface

```bash
# Start a meeting (one call, returns meeting_id, posts the header to the channel)
openclaw agent teleconference start \
  --with <agent-id>                    # e.g. --with ops or --with main
  --topic "<short topic>" \
  --channel telegram \
  --to <chat-id> \
  [--session-id <id>]                  # optional: pin to an existing session

# Send a turn (relays to the remote agent, delivers both sides to the channel)
openclaw agent teleconference send \
  --meeting <meeting_id> \
  --message "<text>"                   # your outbound; reply auto-delivered

# End the meeting (posts the footer, marks the meeting session closed)
openclaw agent teleconference end \
  --meeting <meeting_id> \
  --outcome "<one-line summary>"
```

### Visual protocol (Telegram output)

All three events post via classic Markdown + emojis. No `--parse-mode` needed; OpenClaw's telegram plugin already sends with the legacy `Markdown` mode.

**Meeting open:**

```
🎤 *MEETING OPENED*
━━━━━━━━━━━━━━━━━━━━━
*Topic:* <topic>
*Participants:* 🤖 claude-code ↔ 🦾 <agent-id>
*Meeting ID:* `mtg_...`
━━━━━━━━━━━━━━━━━━━━━
```

**Speaker turn (me → them):**

```
🤖 → 🦾 *claude-code → <agent-id>*
━━━━━━━━━━━━━━━━━━━━━
<message body — Markdown allowed>
━━━━━━━━━━━━━━━━━━━━━
```

**Reply turn (them → me, auto-delivered by `--deliver`):**

```
🦾 → 🤖 *<agent-id> → claude-code*
━━━━━━━━━━━━━━━━━━━━━
<reply body>
━━━━━━━━━━━━━━━━━━━━━
```

**Meeting close:**

```
🔚 *MEETING WRAPPED*
━━━━━━━━━━━━━━━━━━━━━
*Duration:* N turns, MM:SS
*Outcome:* <one-line summary>
*Artifacts:* <commits, files, follow-ups>
━━━━━━━━━━━━━━━━━━━━━
```

### Emoji conventions

| Icon    | Role                                                             |
| ------- | ---------------------------------------------------------------- |
| 🤖      | claude-code (the teleconference initiator in our default config) |
| 🦾      | openclaw / octo agents (octopus arms)                            |
| 🎤      | meeting opened                                                   |
| 🔚      | meeting wrapped                                                  |
| 🔍      | quick ping (one-shot clarification, not a full meeting)          |
| ✅ / ❌ | outcome markers                                                  |
| 💭      | meta commentary from the initiator (outside the transcript)      |

Configurable per-agent via a new optional `agents.<id>.icon` field in `openclaw.json` so users can set `claude-code` to 🤖 and `main` to 🦾 without hardcoding.

### Implementation sketch

**New file:** `src/cli/program/subclis/agent-teleconference.ts` (~150 LOC)

- `start`: generate `meeting_id = mtg_<ulid>`, build opening frame, call `openclaw message send --target ... --message <header>` so the frame is visible without triggering any agent turn; persist `{meeting_id, agent_id, session_id, channel, to, opened_at}` to `~/.openclaw/meetings/<id>.json`.
- `send`: look up meeting by id, delegate to the existing `agent --to --deliver --message` flow but wrap the outbound message in the speaker-turn frame and the returned reply in the reply-turn frame. Two messages land in the channel per turn (my framed outbound + their framed reply).
- `end`: look up meeting, post the closing frame, mark the meeting file as closed with final outcome.

**Optional enhancement:** a `meetings list / show / transcript` subcommand that reads the persisted meeting files and prints a clean transcript for future reference.

**No changes required** to:

- `src/octo/` — this is a plain agent-messaging feature, independent of Octo
- Channel plugins (telegram, etc.) — we're just layering on top of `message send` / `agent --to --deliver`
- Agent routing rules — meetings inherit whatever the target agent's routing already is
- Model providers, auth, policy

### Scope discipline

**In scope:**

- The three verbs above (start/send/end)
- Visual protocol (frames, emojis, classic Markdown)
- Meeting file persistence at `~/.openclaw/meetings/`
- Documentation: user-facing how-to + this concept doc graduating to a design doc

**Deferred:**

- 3+ party meetings (multi-agent fan-out). Start 1:1, learn, then extend.
- Ephemeral meeting channels / topic isolation. Reuse existing channels.
- Meeting transcripts as Octo artifacts. Separate integration.
- A chat slash command (`/meet start @agent topic`). CLI-only for MVP — chat wrapper can come later.
- Voice / video. (Kidding. Mostly.)

## Why this matters beyond UX

The pattern scales up, not just sideways:

- **Debugging**: first use case, already proven (doctor bug)
- **Architecture reviews**: "conference in the agent that owns subsystem X for a read-through"
- **Multi-agent pressure testing**: run a competitive mission (Octo) then hold a meeting with each participant to ask why they made the choices they did — pairs neatly with the ELO rating system that just landed (`01bd20644c`)
- **Specialist consultation**: a `limn-*` agent for domain-specific questions without giving the calling agent that whole system prompt
- **Cross-project handoffs**: agent in repo A teleconferences agent in repo B to transfer context when work needs to cross a boundary

All of this works today via the raw `agent --to --deliver` path. The PR is about making it feel first-class, visible, and remembered — not about inventing new primitives.

## Next steps

1. **Land this doc** as a PR-concept marker in the octopus-orchestrator planning tree (not strictly octo-related, but that's where the pressure-test narrative lives — can move later if we want a dedicated `docs/teleconference/` tree)
2. **Prototype the `start`/`send`/`end` verbs** in a throwaway branch, wire through actual telegram traffic with Michael watching for UX correctness
3. **Graduate to a real PR** against the openclaw repo with tests, docs/cli/agent-teleconference.md, and an end-to-end integration test that uses a qa channel mock

## Appendix: raw command reference (what works right now, no PR needed)

```bash
# Send a visible outbound (posts from bot, no agent turn triggered)
openclaw message send --channel telegram --target 5727573728 \
  --message "[claude-code→openclaw] ..."

# Send an actionable turn (posts both sides via --deliver, triggers agent turn)
openclaw agent --to 5727573728 --channel telegram --deliver --timeout 180 \
  --message "[claude-code→openclaw] ..."

# Read reply from JSON (no --deliver needed for programmatic use)
openclaw agent --to 5727573728 --channel telegram --json --timeout 180 \
  --message "..." | jq -r '.result.meta.finalAssistantVisibleText'
```

See also: `~/.claude/projects/-Users-michaelmartoccia/memory/reference_openclaw_dm_chat.md` for the saved convention on this specific chat bridge.
