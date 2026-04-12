# Teleconference Dial — Bidirectional Meeting Initiation (Prototype)

**Status:** prototype (2026-04-12)
**Dependency:** `docs/octopus-orchestrator/AGENT-TELECONFERENCE.md` (meeting protocol)
**Scripts:** `scripts/teleconference/meet-dial.sh`, `scripts/teleconference/meet-check.sh`

## The problem it solves

The base teleconference pattern (`openclaw agent --to --deliver`) is **unidirectional from the caller's side**: Claude Code can initiate a meeting with openclaw main, but openclaw main cannot initiate a meeting back. The reason is structural — Claude Code is an interactive CLI REPL with no listening port, no polling loop, nothing for an outside process to dial into.

What Michael wanted was:

> "I'm in Telegram chatting with openclaw main. I want to say 'conference in claude-code about X' and have that trigger a meeting request the Claude Code side will pick up."

True async delivery isn't possible — nobody's home on the Claude Code side to answer. But we can get the next best thing: **user-gated pickup via a file inbox + macOS notification**.

## How it works

```
 ┌─────────────────────┐
 │  Telegram DM        │
 │  Michael → main     │  "conference in claude-code about X"
 └─────────┬───────────┘
           │
           ▼
 ┌─────────────────────┐
 │  openclaw main      │  runs scripts/teleconference/meet-dial.sh --to claude-code --topic "X"
 │  (agent tool call)  │
 └─────────┬───────────┘
           │
           ▼
 ┌───────────────────────────────────────┐    ┌───────────────────────────┐
 │  ~/.openclaw/meetings/pending/        │    │  macOS notification       │
 │    mtg_<ts>_<rand>.json  ◄────────────┼────┤  "📞 Meeting pending:     │
 │                                       │    │   main → claude-code: X"  │
 └─────────┬─────────────────────────────┘    └───────────────────────────┘
           │                                             │
           │                                             │ Michael sees banner
           │                                             │ on his Mac
           │                                             ▼
           │                                  ┌─────────────────────────┐
           │                                  │  Michael pops into the  │
           │                                  │  Claude Code terminal   │
           │                                  └──────────┬──────────────┘
           │                                             │
           │           "check meetings" / "go"           │
           │◄────────────────────────────────────────────┘
           │
           ▼
 ┌─────────────────────┐
 │  Claude Code reads  │   scripts/teleconference/meet-check.sh
 │  pending/ directory │   OR Read + Glob on the same path
 └─────────┬───────────┘
           │
           │  Moves file from pending/ → active/, opens the meeting via
           │  the existing agent --to --deliver flow, reply auto-posts
           │  back to the original chat (because reply_via was captured
           │  when the dial happened)
           │
           ▼
 ┌─────────────────────┐
 │  Meeting runs as    │
 │  normal (see        │
 │  AGENT-             │
 │  TELECONFERENCE.md) │
 └─────────────────────┘
```

## File format (single source of truth)

A pending meeting is a plain JSON file at `~/.openclaw/meetings/pending/<meeting_id>.json`:

```json
{
  "meeting_id": "mtg_1776002260868_abfb34",
  "from_agent": "openclaw-main",
  "from_channel": "telegram",
  "from_chat_id": "5727573728",
  "to_agent": "claude-code",
  "topic": "remote sentinel polling — is it still racy under load?",
  "context": "I noticed an edge case when 3 arms complete within 50ms",
  "reply_via": "telegram:5727573728",
  "created_at": "2026-04-12T13:57:40Z",
  "status": "pending"
}
```

**Lifecycle:**

| State     | Directory                       | Set by                                                      |
| --------- | ------------------------------- | ----------------------------------------------------------- |
| `pending` | `~/.openclaw/meetings/pending/` | `meet-dial.sh` creates it                                   |
| `active`  | `~/.openclaw/meetings/active/`  | Claude Code moves it on pickup, adds `started_at`           |
| `closed`  | `~/.openclaw/meetings/closed/`  | Claude Code moves it on wrap, adds `ended_at` and `outcome` |

Lifecycle transitions are file _moves_, not edits — guarantees atomicity without needing lock files. Future tooling can glob by state subdirectory without parsing content.

## CLI

### `meet-dial.sh` — request a meeting

```bash
scripts/teleconference/meet-dial.sh \
  --to <agent-id> \
  --topic "<short topic>" \
  [--context "<longer context>"] \
  [--from <caller-agent>] \
  [--from-channel <channel>] \
  [--from-chat <chat-id>] \
  [--reply-via <channel:chat>] \
  [--no-notify] \
  [--quiet]
```

Writes the JSON file, dispatches a macOS notification via `osascript`. Exits 0 on success, prints the `meeting_id` to stdout.

**Openclaw main agent invocation pattern** (for telegram triggers):

```bash
/Users/michaelmartoccia/clawd/openclaw_repo-octopus/scripts/teleconference/meet-dial.sh \
  --to claude-code \
  --topic "$USER_SUPPLIED_TOPIC" \
  --from openclaw-main \
  --from-channel telegram \
  --from-chat 5727573728
```

### `meet-check.sh` — list meetings

```bash
scripts/teleconference/meet-check.sh \
  [--state pending|active|closed|all] \
  [--to <agent>] \
  [--json]
```

Default is `--state pending`. Output is a human-friendly listing or JSON array. Claude Code calls this (or reads the directory directly) when Michael says "check meetings", "any pending", or just starts a conversation after receiving a notification.

## Claude Code pickup workflow

When Michael says "check meetings" (or anything that signals pickup intent) in the Claude Code terminal:

1. **Run** `./scripts/teleconference/meet-check.sh --to claude-code`
2. **For each pending entry**, read the JSON, announce to Michael what the request is, and confirm whether to proceed
3. **On confirmation**, move the file from `pending/` to `active/` (adds `started_at` timestamp on the way)
4. **Open the meeting** via the existing pattern:
   ```bash
   openclaw agent --to <from_chat_id> --channel <from_channel> --deliver \
     --message "🎤 *MEETING OPENED* — <topic> ..."
   ```
   using the `reply_via` field from the dial request to route the reply back
5. **Run the meeting** as normal (see `AGENT-TELECONFERENCE.md` for visual protocol)
6. **On wrap**, move the file from `active/` to `closed/` with `ended_at` + `outcome` fields

This keeps the file system as the source of truth — any other Claude Code session (or future tooling) can reconstruct what happened by reading the three directories.

## Notifications

Currently macOS-only via `osascript -e 'display notification ...'`. The script's `--no-notify` flag is for tests/CI and for platforms where this doesn't apply.

**Permissions:** macOS requires notification permissions for whatever app is running the shell. If you don't see banners, check `System Settings → Notifications` for your terminal (Terminal, iTerm, Ghostty, etc.) and ensure notifications are allowed.

**Linux/Windows** will need alternative backends — `notify-send` (libnotify) on Linux, `BurntToast` PowerShell module on Windows. Easy to add when needed; they'd live behind a simple dispatcher function in `meet-dial.sh`.

## What this prototype is not

- **Not a real CLI verb yet.** `openclaw agent teleconference dial` is the target shape (see `AGENT-TELECONFERENCE.md`). This prototype uses a shell script so we can iterate without touching the openclaw TypeScript CLI.
- **Not tied into OpenClaw sessions.** The meeting files live in `~/.openclaw/meetings/`, but they're not registered in the sqlite session store. Future work: promote active meetings to real session entries.
- **Not transactional.** Two concurrent `meet-dial.sh` calls with the same timestamp have a tiny collision window; the random suffix mostly covers it but a real implementation should use ULIDs.
- **No cleanup.** `closed/` grows forever. Real implementation needs a retention policy or a `meet prune` verb.
- **No ACK back to the dialer.** When Claude Code picks up, openclaw main has no way of knowing. Future: write an `ack.json` next to the meeting file that the dialer can poll.

## Graduation path

This prototype proves the pattern. When we're ready to graduate:

1. **Promote to TypeScript** — implement as `openclaw agent teleconference dial / check / pickup / wrap` in `src/cli/program/subclis/agent-teleconference.ts`. Delete the shell scripts.
2. **Integrate with OpenClaw sessions** — a meeting becomes a first-class session type, queryable via existing `openclaw sessions` commands.
3. **Add cross-platform notifications** via a small dispatcher that picks `osascript` / `notify-send` / `BurntToast` based on `process.platform`.
4. **Add ACK + timeout** — dialer can see whether the target picked up, and requests expire after N minutes.
5. **Eventually**: a chat-level `/meet dial` slash command so Michael doesn't need to teach openclaw main the shell invocation each session.

## Teach openclaw main

Openclaw main needs to know the dial command exists to run it when triggered from Telegram. Until we graduate to system-prompt integration, the pattern is:

- When Michael says _"conference in claude-code about X"_ (or variations) in Telegram
- Openclaw main responds by running the bash command above
- Openclaw main acknowledges in chat: _"📞 Dialed claude-code. Meeting id `<id>`. Topic: <topic>. Waiting for pickup."_
- The macOS notification tells Michael to switch terminals
- In Claude Code, Michael says something (anything), I check pending meetings, pick up, open a visible meeting via `agent --to --deliver`, and the conversation flows back through Telegram

**First-time setup note:** each openclaw session needs to see this instruction in its context at least once. Either inject it via IDENTITY.md (permanent) or teach it in-turn (one-shot, expires with the session). This prototype uses the one-shot approach — see the test run log in `docs/octopus-orchestrator/SESSION-LOG.md` if you need the exact wording used.
