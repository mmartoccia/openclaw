#!/usr/bin/env bash
# meet-check.sh — List teleconference meetings by state.
#
# Prints pending / active / closed meeting entries as a flat table
# (or JSON array with --json) so Claude Code / openclaw agents can
# pick up work without polling code.
#
# Usage:
#   meet-check.sh [--state pending|active|closed|all] [--to <agent>] [--json]
#
# Defaults:
#   --state pending
#   --to is not filtered

set -eu

state="pending"
filter_to=""
as_json=0

while [ $# -gt 0 ]; do
  case "$1" in
    --state) state="$2"; shift 2 ;;
    --to) filter_to="$2"; shift 2 ;;
    --json) as_json=1; shift ;;
    -h|--help) sed -n '1,25p' "$0"; exit 0 ;;
    *) echo "meet-check: unknown arg: $1" >&2; exit 1 ;;
  esac
done

root="${HOME}/.openclaw/meetings"

collect_state() {
  local s="$1"
  local dir="${root}/${s}"
  [ -d "$dir" ] || return 0
  for f in "${dir}"/*.json; do
    [ -e "$f" ] || continue
    echo "$f"
  done
}

if [ "$state" = "all" ]; then
  files=$( { collect_state pending; collect_state active; collect_state closed; } )
else
  files=$(collect_state "$state")
fi

python3 - <<PY
import json, os, sys

files_raw = """$files"""
files = [f for f in files_raw.strip().split("\n") if f]
filter_to = """$filter_to""".strip()
as_json = $as_json

entries = []
for path in files:
    try:
        with open(path) as fh:
            doc = json.load(fh)
    except Exception as e:
        continue
    if filter_to and doc.get("to_agent") != filter_to:
        continue
    doc["_path"] = path
    doc["_state"] = os.path.basename(os.path.dirname(path))
    entries.append(doc)

entries.sort(key=lambda d: d.get("created_at", ""))

if as_json:
    print(json.dumps(entries, indent=2))
else:
    if not entries:
        print("(no meetings)")
    else:
        for e in entries:
            mtg = e.get("meeting_id", "?")
            from_a = e.get("from_agent", "?")
            to_a = e.get("to_agent", "?")
            topic = e.get("topic", "(no topic)")
            ts = e.get("created_at", "?")
            st = e.get("_state", "?")
            print(f"[{st:7}] {mtg}")
            print(f"         {from_a} → {to_a}")
            print(f"         topic: {topic}")
            print(f"         at:    {ts}")
            ctx = e.get("context", "").strip()
            if ctx:
                print(f"         context: {ctx}")
            rv = e.get("reply_via", "")
            if rv:
                print(f"         reply_via: {rv}")
            print()
PY
