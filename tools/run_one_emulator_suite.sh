#!/bin/bash
# Runs one functions suite against a fresh Firestore emulator.
#
#   tools/run_one_emulator_suite.sh functions/test/profile_media_test.mjs
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUITE="${1:?the suite to run}"
PORT="${2:-8281}"
PROJECT="demo-stayserve-one-suite"
EMU_DIR="$(mktemp -d /private/var/folders/0s/171d1s9d1pnd0f5yvn648vyc0000gn/T/opencode/emulator-one.XXXXXX)"
FIREBASE="$(command -v firebase || true)"

cleanup() {
  pkill -f "emulators:start --only firestore --project $PROJECT" 2>/dev/null || true
  rm -rf "$EMU_DIR"
}
trap cleanup EXIT

mkdir -p "$EMU_DIR"
cat > "$EMU_DIR/firebase.json" <<EOF
{
  "firestore": {
    "rules": "$ROOT/firestore.rules",
    "indexes": "$ROOT/firestore.indexes.json"
  },
  "emulators": {
    "firestore": { "port": $PORT },
    "ui": { "enabled": false },
    "hub": { "port": $((PORT + 1)) }
  }
}
EOF
cat > "$EMU_DIR/.firebaserc" <<EOF
{ "projects": { "default": "$PROJECT" } }
EOF

(
  cd "$EMU_DIR"
  exec "$FIREBASE" emulators:start --only firestore --project "$PROJECT"
) > "$EMU_DIR/emulator.log" 2>&1 &
EMU_PID=$!

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
  echo "The Firestore emulator did not start. Log:"
  cat "$EMU_DIR/emulator.log"
  exit 1
fi

node "$ROOT/$SUITE" "$PORT" "$PROJECT"
