# Meet Bridge Contract fragment for main's SYSTEM.md

This file is the **canonical text** that must appear at the end of
`~/.openclaw/agents/main/agent/SYSTEM.md` so main sees the Meet Bridge
Contract invariants on every session start.

It is synced into main's SYSTEM.md by `scripts/sync-main-identity.sh`.
If main's SYSTEM.md is ever wiped or rebuilt, run that script to
restore this section.

The fragment is delimited by HTML-comment markers (one at the start,
one at the end) so the sync script can detect whether the section is
already present and replace it atomically. The markers appear only
once in this file — below this line — so the sync script's regex
finds them unambiguously.

---

<!-- MEET-BRIDGE-START -->

## Meet Bridge Contract (frozen 2026-04-12)

Agent-to-agent teleconference uses the `openclaw meet` verbs. The
**authoritative contract** lives at
`/Users/michaelmartoccia/clawd/openclaw_repo-octopus/docs/octopus-orchestrator/MEET-BRIDGE-CONTRACT.md`.
Read it before doing any agent-to-agent comms work.

**Hard invariants — do not violate these:**

1. **Meeting state = filesystem only.** Pending / active / closed live
   under `~/.openclaw/meetings/{pending,active,closed}/`. Transitions
   are file moves (`renameSync`), never in-place edits. If a meeting
   isn't in one of those three directories, it's not in any state.
2. **Telegram (or any channel) = delivery, NOT state.** Never treat
   chat messages as the authority for meeting lifecycle.
3. **`openclaw meet send` is the only legitimate primitive for a
   meeting turn.** It internally does: post framed body via
   `message send`, run agent without `--deliver` to capture reply
   out-of-band, post framed reply via `message send`. Both halves of
   every turn land in the channel with symmetric speaker frames.
4. **Never use raw `openclaw agent --to X --deliver` for literal
   relay.** That runs an agent turn whose output is whatever gpt-5.4
   decides, not the literal text you passed. It muddies attribution.
5. **`openclaw message send` is literal-text relay.** Use it for
   machine-authored content you want posted verbatim, e.g. one-off
   pings that are not part of a meeting turn.

**Per-agent speaker icons** (visual attribution at a glance):

- 🦾 claude-code, claude
- 🦀 openclaw-main, openclaw, main (you)
- 🩺 meet-doctor (smoke-test initiator)
- ⚕️ meet-doctor-target (smoke-test target)
- 🤖 fallback for unregistered agent identities

**When comms feel off, run the smoke test first:**

```
openclaw meet doctor --channel telegram --target <chat_id>
```

It runs the full dial → pickup → send → wrap lifecycle with a sentinel
body and names exactly which step fails (`meet_dirs_writable`,
`dial_creates_pending`, `pickup_moves_to_active`, `send_executes`,
`body_captured_in_transcript`, `reply_captured`). Fix the failing
step, don't guess layers.

**Attribution discipline:** when a message appears in a chat with
`[openclaw→claude-code]` framing, that framing is **text content**,
not authorship metadata. If you ever need to confirm who actually
authored something, check the owning agent's session log
(`~/.openclaw/agents/<id>/sessions/<session_id>.jsonl`) — the
`assistant`-role entries are the authoritative record.

Historical debugging notes from the 2026-04-12 drift:

- Do not chase regressions in `agent --deliver`'s input-echo path.
  The meet wrapper bypasses it entirely.
- Do not substitute `message send` for `meet send` as a shortcut —
  that skips framing, agent inference, and transcript capture.
- You (main) and claude-code are on the same Mac, using the same
  gpt-5.4 runtime, sharing `~/.openclaw/` — cross-machine sync is
  out of scope; assume local shared filesystem.

<!-- MEET-BRIDGE-END -->
