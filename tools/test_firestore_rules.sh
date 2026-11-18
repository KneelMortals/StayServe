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
EMU_DIR="$(mktemp -d "${TMPDIR:-/tmp}/stayserve-firestore-rules.XXXXXX")"
PROJECT="demo-stayserve-rules-$$"

pick_port() {
  local preferred="$1"
  shift
  if ! nc -z 127.0.0.1 "$preferred" 2>/dev/null; then
    echo "$preferred"
    return
  fi
  for candidate in "$@"; do
    if ! nc -z 127.0.0.1 "$candidate" 2>/dev/null; then
      echo "$candidate"
      return
    fi
  done
  echo "No free port is available for this emulator." >&2
  exit 1
}

# A leftover emulator of an earlier run must never answer for this one; it
# would carry the old data and the old rules.
PORT="$(pick_port "${FIRESTORE_EMULATOR_PORT:-8181}" 8182 8183 8184 8185 8190 8191 8192 8193)"
HUB_PORT="$(pick_port 4411 4412 4413 4414 4415 4416 4417 4418)"

if [[ -x "$ROOT/node_modules/.bin/firebase" ]]; then
  FIREBASE="$ROOT/node_modules/.bin/firebase"
elif command -v firebase >/dev/null 2>&1; then
  FIREBASE="$(command -v firebase)"
else
  echo "firebase-tools is not installed." >&2
  exit 1
fi

kill_port_listener() {
  local port="$1"
  [[ -n "$port" ]] || return 0
  command -v lsof >/dev/null 2>&1 || return 0

  local pids=()
  while IFS= read -r pid; do
    [[ -n "$pid" ]] && pids+=("$pid")
  done < <(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)

  if ((${#pids[@]})); then
    kill "${pids[@]}" 2>/dev/null || true
    sleep 1
    kill -KILL "${pids[@]}" 2>/dev/null || true
  fi
}

cleanup() {
  if [[ -n "${EMU_PID:-}" ]] && kill -0 "$EMU_PID" 2>/dev/null; then
    # The Firebase CLI starts the Java emulator as a child. Killing only the
    # CLI can orphan that listener and make a later suite talk to stale data.
    pkill -TERM -P "$EMU_PID" 2>/dev/null || true
    kill "$EMU_PID" 2>/dev/null || true
    wait "$EMU_PID" 2>/dev/null || true
  fi
  kill_port_listener "$PORT"
  kill_port_listener "$HUB_PORT"
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
(
  cd "$EMU_DIR"
  exec "$FIREBASE" emulators:start \
    --only firestore \
    --project "$PROJECT"
) > "$EMU_DIR/emulator.log" 2>&1 &
EMU_PID=$!

# Wait for both the listener and the CLI readiness marker. The HTTP listener
# can answer a fraction of a second before the CLI prints its ready banner.
ready=false
for _ in $(seq 1 90); do
  if curl -s -o /dev/null "http://127.0.0.1:$PORT/" && \
    grep -q "All emulators ready" "$EMU_DIR/emulator.log"; then
    ready=true
    break
  fi
  sleep 1
done

if [[ "$ready" != true ]]; then
  echo "The Firestore emulator did not become ready. Log:"
  cat "$EMU_DIR/emulator.log"
  exit 1
fi

node "$ROOT/tools/firestore_rules_test.mjs" "$PORT" "$PROJECT"
