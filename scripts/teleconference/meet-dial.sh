#!/usr/bin/env bash
# meet-dial.sh — Request a teleconference with another agent.
#
# Writes a pending meeting JSON file to ~/.openclaw/meetings/pending/
# and fires a macOS system notification so the target agent's operator
# sees the request without having to poll.
#
# Intended invocation patterns:
#   1. Openclaw main agent runs this when the user says
#      "conference in claude-code about <topic>" in telegram
#   2. Claude Code runs this when I want to notify a different agent
#      (future: when teleconference verbs support multi-target fan-out)
#
# File format is the single source of truth for pending meetings —
# see TELECONFERENCE-DIAL.md for schema and lifecycle.
#
# Usage:
#   meet-dial.sh --to <agent-id> --topic "<topic>" [options]
#
# Options:
#   --to <agent>          Target agent id (required; e.g. claude-code)
#   --topic <text>        Short topic / question (required)
#   --context <text>      Optional longer context (one line)
#   --from <agent>        Caller agent id (default: $OPENCLAW_AGENT_ID or "unknown")
#   --from-channel <ch>   Caller's channel (default: "cli")
#   --from-chat <id>      Caller's chat_id (default: none)
#   --reply-via <spec>    How the caller wants the reply routed back
#                         (default: same as from-channel:from-chat, e.g.
#                         "telegram:5727573728")
#   --no-notify           Skip the macOS notification (useful for tests)
#   --quiet               Don't print to stdout (only the meeting_id)
#
# Exit codes:
#   0 — meeting created, file written, notification dispatched
#   1 — usage / missing required args
#   2 — filesystem error

set -eu

to_agent=""
topic=""
context=""
from_agent="${OPENCLAW_AGENT_ID:-unknown}"
from_channel="cli"
from_chat=""
reply_via=""
do_notify=1
quiet=0

while [ $# -gt 0 ]; do
  case "$1" in
    --to) to_agent="$2"; shift 2 ;;
    --topic) topic="$2"; shift 2 ;;
    --context) context="$2"; shift 2 ;;
    --from) from_agent="$2"; shift 2 ;;
    --from-channel) from_channel="$2"; shift 2 ;;
    --from-chat) from_chat="$2"; shift 2 ;;
    --reply-via) reply_via="$2"; shift 2 ;;
    --no-notify) do_notify=0; shift ;;
    --quiet) quiet=1; shift ;;
    -h|--help) sed -n '1,40p' "$0"; exit 0 ;;
    *) echo "meet-dial: unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [ -z "$to_agent" ] || [ -z "$topic" ]; then
  echo "Usage: meet-dial.sh --to <agent> --topic <text> [--context <text>] [--from <agent>] [--from-channel <ch>] [--from-chat <id>]" >&2
  exit 1
fi

# Default reply route: reflect the inbound path so the target agent
# knows where to deliver its reply.
if [ -z "$reply_via" ] && [ -n "$from_chat" ]; then
  reply_via="${from_channel}:${from_chat}"
fi

# Meeting id: prefix + epoch-ms + 6 random hex chars (collision-resistant
# enough for a prototype without pulling in a ULID dep).
now_ms=$(python3 -c 'import time; print(int(time.time()*1000))')
rand=$(python3 -c 'import secrets; print(secrets.token_hex(3))')
mtg_id="mtg_${now_ms}_${rand}"

meetings_dir="${HOME}/.openclaw/meetings/pending"
mkdir -p "$meetings_dir"
out="${meetings_dir}/${mtg_id}.json"

# JSON escaping via python so we don't have to hand-roll it
python3 - <<PY > "$out"
import json, datetime
doc = {
    "meeting_id": "${mtg_id}",
    "from_agent": "${from_agent}",
    "from_channel": "${from_channel}",
    "from_chat_id": "${from_chat}",
    "to_agent": "${to_agent}",
    "topic": """${topic}""",
    "context": """${context}""",
    "reply_via": "${reply_via}",
    "created_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "status": "pending",
}
print(json.dumps(doc, indent=2))
PY

if [ $do_notify -eq 1 ] && command -v osascript >/dev/null 2>&1; then
  # Escape double-quotes for AppleScript string
  esc_topic=$(printf '%s' "$topic" | sed 's/"/\\"/g')
  esc_from=$(printf '%s' "$from_agent" | sed 's/"/\\"/g')
  osascript -e "display notification \"${esc_from} → ${to_agent}: ${esc_topic}\" with title \"📞 Meeting pending (${to_agent})\" sound name \"Glass\"" >/dev/null 2>&1 || true
fi

if [ $quiet -eq 0 ]; then
  echo "meeting_id: ${mtg_id}"
  echo "file:       ${out}"
  echo "to:         ${to_agent}"
  echo "topic:      ${topic}"
  if [ -n "$reply_via" ]; then
    echo "reply_via:  ${reply_via}"
  fi
else
  echo "$mtg_id"
fi
