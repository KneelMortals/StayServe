#!/usr/bin/env bash
#
# Runs the Cloud Storage security-rules test suite against the local
# Firestore + Storage emulators.
#
# The Storage rules read the live account state from Firestore, so both
# emulators have to run together.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EMU_DIR="$(mktemp -d "${TMPDIR:-/tmp}/stayserve-storage-rules.XXXXXX")"
PROJECT="demo-ss-storage-$$"

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

FIRESTORE_PORT="$(pick_port 8181 8182 8183 8184 8185 8190 8191 8192 8193)"
STORAGE_PORT="$(pick_port 9199 9200 9201 9202 9203 9204 9205 9206)"
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
    # The Firebase CLI starts the Java emulators as children. Killing only
    # the CLI can orphan a listener and make a later suite use stale data.
    pkill -TERM -P "$EMU_PID" 2>/dev/null || true
    kill "$EMU_PID" 2>/dev/null || true
    wait "$EMU_PID" 2>/dev/null || true
  fi
  kill_port_listener "$FIRESTORE_PORT"
  kill_port_listener "$STORAGE_PORT"
  kill_port_listener "$HUB_PORT"
  pkill -f "emulators:start --only firestore,storage --project $PROJECT" 2>/dev/null || true
  rm -rf "$EMU_DIR"
}
trap cleanup EXIT

cat > "$EMU_DIR/firebase.json" <<EOF
{
  "firestore": {
    "rules": "$ROOT/firestore.rules",
    "indexes": "$ROOT/firestore.indexes.json"
  },
  "storage": {
    "rules": "$ROOT/storage.rules"
  },
  "emulators": {
    "firestore": { "port": $FIRESTORE_PORT },
    "storage": { "port": $STORAGE_PORT },
    "ui": { "enabled": false },
    "hub": { "port": $HUB_PORT }
  }
}
EOF

cat > "$EMU_DIR/.firebaserc" <<EOF
{ "projects": { "default": "$PROJECT" } }
EOF

echo "Starting the Firestore and Storage emulators..."
(
  cd "$EMU_DIR"
  exec "$FIREBASE" emulators:start \
    --only firestore,storage \
    --project "$PROJECT"
) > "$EMU_DIR/emulator.log" 2>&1 &
EMU_PID=$!

# Wait for both listeners and the CLI readiness marker. The HTTP listeners
# can answer a fraction of a second before the CLI prints its ready banner.
ready=false
for _ in $(seq 1 90); do
  if curl -s -o /dev/null "http://127.0.0.1:$FIRESTORE_PORT/" &&
    curl -s -o /dev/null "http://127.0.0.1:$STORAGE_PORT/" &&
    grep -q "All emulators ready" "$EMU_DIR/emulator.log"; then
    ready=true
    break
  fi
  sleep 1
done

if [[ "$ready" != true ]]; then
  echo "The Firestore and Storage emulators did not become ready. Log:"
  cat "$EMU_DIR/emulator.log"
  exit 1
fi

node "$ROOT/tools/storage_rules_test.mjs" \
  "$STORAGE_PORT" \
  "$PROJECT" \
  "$FIRESTORE_PORT"
