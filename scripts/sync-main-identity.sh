#!/usr/bin/env bash
# sync-main-identity.sh — idempotently sync the Meet Bridge Contract
# fragment into main's SYSTEM.md.
#
# main's identity file at ~/.openclaw/agents/main/agent/SYSTEM.md is
# user-local state (not in the repo). If it ever gets wiped, rebuilt,
# or drifts, this script restores the Meet Bridge Contract section
# from the repo-committed canonical fragment at
# docs/octopus-orchestrator/meet-bridge-SYSTEM-fragment.md
#
# Idempotent: safe to run multiple times. Detects existing fragment by
# the <!-- MEET-BRIDGE-START --> / <!-- MEET-BRIDGE-END --> markers
# and atomically replaces the section between them (or appends if
# missing).
#
# Usage:
#   scripts/sync-main-identity.sh                    # apply sync
#   scripts/sync-main-identity.sh --check            # verify only, no write
#   scripts/sync-main-identity.sh --dry-run          # print what would change
#
# Exit codes:
#   0 — fragment is in sync (or was just synced)
#   1 — SYSTEM.md missing entirely
#   2 — fragment file missing from repo
#   3 — --check mode, fragment out of sync

set -eu

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FRAGMENT_FILE="${ROOT_DIR}/docs/octopus-orchestrator/meet-bridge-SYSTEM-fragment.md"
SYSTEM_FILE="${HOME}/.openclaw/agents/main/agent/SYSTEM.md"

mode="apply"
for arg in "$@"; do
  case "$arg" in
    --check) mode="check" ;;
    --dry-run) mode="dry-run" ;;
    -h|--help)
      sed -n '1,30p' "$0"
      exit 0
      ;;
    *)
      echo "sync-main-identity: unknown arg: $arg" >&2
      exit 1
      ;;
  esac
done

if [ ! -f "$FRAGMENT_FILE" ]; then
  echo "sync-main-identity: fragment file missing: $FRAGMENT_FILE" >&2
  exit 2
fi

if [ ! -f "$SYSTEM_FILE" ]; then
  echo "sync-main-identity: SYSTEM.md missing: $SYSTEM_FILE" >&2
  echo "sync-main-identity: main agent must be initialized first" >&2
  exit 1
fi

# Single Python invocation handles extract + compare + write.
# Reads mode from env, returns exit code directly.
python3 - "$FRAGMENT_FILE" "$SYSTEM_FILE" "$mode" <<'PY'
import re
import sys
from pathlib import Path

fragment_path = Path(sys.argv[1])
system_path = Path(sys.argv[2])
mode = sys.argv[3]

START = "<!-- MEET-BRIDGE-START -->"
END = "<!-- MEET-BRIDGE-END -->"

fragment_text = fragment_path.read_text()
system_text = system_path.read_text()

fragment_match = re.search(
    re.escape(START) + r"(.*?)" + re.escape(END),
    fragment_text,
    re.DOTALL,
)
if not fragment_match:
    print(
        f"sync-main-identity: markers not found in fragment file {fragment_path}",
        file=sys.stderr,
    )
    sys.exit(2)

fragment_body = START + fragment_match.group(1) + END

existing_match = re.search(
    re.escape(START) + r"(.*?)" + re.escape(END),
    system_text,
    re.DOTALL,
)

if existing_match:
    existing_body = START + existing_match.group(1) + END
    if existing_body == fragment_body:
        print("sync-main-identity: ✅ fragment in sync")
        sys.exit(0)
    action = "replace"
    new_text = (
        system_text[: existing_match.start()]
        + fragment_body
        + system_text[existing_match.end() :]
    )
else:
    action = "append"
    sep = "\n\n---\n\n" if system_text and not system_text.endswith("\n\n") else ""
    new_text = system_text + sep + fragment_body + "\n"

if mode == "check":
    print(
        f"sync-main-identity: ❌ fragment NOT in sync (would {action})",
        file=sys.stderr,
    )
    print("sync-main-identity: run without --check to sync", file=sys.stderr)
    sys.exit(3)

if mode == "dry-run":
    print(
        f"sync-main-identity: DRY RUN — would {action} fragment in {system_path}"
    )
    sys.exit(0)

system_path.write_text(new_text)
print(
    f"sync-main-identity: ✅ {action}d fragment in {system_path}"
)
sys.exit(0)
PY
