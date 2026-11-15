#!/usr/bin/env bash
#
# Runs the Firestore security-rules test suite against the local emulator.
#
#   1. start the emulator (it picks up ../firestore.rules)
#   2. run the assertions
#
# Usage:
#   tools/test_firestore_rules.sh
#
# The emulator is stopped again when the script exits.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EMU_DIR="$(mktemp -d)"
# A free port — a leftover emulator of an earlier run must never be able to
# answer for this one (it would carry the *old* data and the *old* rules).
PORT="${FIRESTORE_EMULATOR_PORT:-8181}"
if ! nc -z 127.0.0.1 "$PORT" 2>/dev/null; then
  :
else
  # The port is busy — take the next free one.
  for candidate in 8182 8183 8184 8185 8190 8191 8192 8193; do
    if ! nc -z 127.0.0.1 "$candidate" 2>/dev/null; then
      PORT="$candidate"
      break
    fi
  done
fi
# The hub needs a free port as well — it is the one that failed the last run
# because a leftover emulator was still holding it.
HUB_PORT=4411
for candidate in 4411 4412 4413 4414 4415 4416 4417 4418; do
  if ! nc -z 127.0.0.1 "$candidate" 2>/dev/null; then
    HUB_PORT="$candidate"
    break
  fi
done
PROJECT="demo-stayserve-rules"

cleanup() {
  if [[ -n "${EMU_PID:-}" ]] && kill -0 "$EMU_PID" 2>/dev/null; then
    kill "$EMU_PID" 2>/dev/null || true
    wait "$EMU_PID" 2>/dev/null || true
  fi
  # The emulator runs as a child of the Firebase CLI — killing the CLI is
  # not always enough, and a leftover emulator would answer the next run
  # with its old data.
  pkill -f "emulators:start --only firestore --project $PROJECT" 2>/dev/null || true
  rm -rf "$EMU_DIR"
}
trap cleanup EXIT

cat > "$EMU_DIR/firebase.json" <<EOF
{
  "firestore": {
    "rules": "$ROOT/firestore.rules",
    "indexes": "$ROOT/firestore.indexes.json"
  },
  "emulators": {
    "firestore": { "port": $PORT },
    "ui": { "enabled": false },
    "hub": { "port": $HUB_PORT }
  }
}
EOF

cat > "$EMU_DIR/.firebaserc" <<EOF
{ "projects": { "default": "$PROJECT" } }
EOF

echo "Starting the Firestore emulator on port $PORT ..."
(cd "$EMU_DIR" && exec firebase emulators:start --only firestore --project "$PROJECT" > emulator.log 2>&1) &
EMU_PID=$!

# Wait until the emulator answers.
for _ in $(seq 1 60); do
  if curl -s -o /dev/null "http://127.0.0.1:$PORT/"; then
    break
  fi
  sleep 1
done

if ! curl -s -o /dev/null "http://127.0.0.1:$PORT/"; then
  echo "The emulator did not start. Log:"
  cat "$EMU_DIR/emulator.log"
  exit 1
fi

# The emulator that answers has to be **ours** — a leftover one of an older
# run would carry the data of that run and make the checks lie.
if ! grep -q "All emulators ready" "$EMU_DIR/emulator.log"; then
  echo "The emulator on port $PORT is not the one that was started here."
  echo "Log:"
  cat "$EMU_DIR/emulator.log"
  exit 1
fi

node "$ROOT/tools/firestore_rules_test.mjs" "$PORT" "$PROJECT"
