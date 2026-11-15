#!/usr/bin/env bash
#
# Runs the tests of the batched maintenance helpers against the local
# Firestore emulator.
#
#   tools/test_batches.sh
#
# The emulator is stopped again when the script exits.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EMU_DIR="$(mktemp -d)"
# A free port — a leftover emulator of an earlier run must never be able to
# answer for this one (it would carry the *old* data).
PORT="${FIRESTORE_EMULATOR_PORT:-8181}"
if ! nc -z 127.0.0.1 "$PORT" 2>/dev/null; then
  :
else
  for candidate in 8182 8183 8184 8185 8190 8191 8192 8193; do
    if ! nc -z 127.0.0.1 "$candidate" 2>/dev/null; then
      PORT="$candidate"
      break
    fi
  done
fi
HUB_PORT=4421
for candidate in 4421 4422 4423 4424 4425 4426 4427 4428; do
  if ! nc -z 127.0.0.1 "$candidate" 2>/dev/null; then
    HUB_PORT="$candidate"
    break
  fi
done
PROJECT="demo-stayserve-batches"

cleanup() {
  if [[ -n "${EMU_PID:-}" ]] && kill -0 "$EMU_PID" 2>/dev/null; then
    kill "$EMU_PID" 2>/dev/null || true
    wait "$EMU_PID" 2>/dev/null || true
  fi
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

if ! grep -q "All emulators ready" "$EMU_DIR/emulator.log"; then
  echo "The emulator on port $PORT is not the one that was started here."
  echo "Log:"
  cat "$EMU_DIR/emulator.log"
  exit 1
fi

node "$ROOT/tools/batches_test.mjs" "$PORT" "$PROJECT"
