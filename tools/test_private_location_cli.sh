#!/usr/bin/env bash
#
# End-to-end regression for the private-location operator CLI.
#
# The test uses a disposable Firestore emulator. It seeds one legacy public
# listing, migrates it, verifies the whole database, finalizes the private
# format, and proves that the compatibility switch cannot be reopened.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EMU_DIR="$(mktemp -d "${TMPDIR:-/tmp}/stayserve-location-cli.XXXXXX")"
PROJECT="demo-stayserve-location-cli-$$"

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

FIRESTORE_PORT="$(pick_port 8281 8282 8283 8284 8285 8286 8287 8288 8289)"
HUB_PORT="$(pick_port 4421 4422 4423 4424 4425 4426 4427 4428 4429)"

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
    pkill -TERM -P "$EMU_PID" 2>/dev/null || true
    kill "$EMU_PID" 2>/dev/null || true
    wait "$EMU_PID" 2>/dev/null || true
  fi
  kill_port_listener "$FIRESTORE_PORT"
  kill_port_listener "$HUB_PORT"
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
    "firestore": { "port": $FIRESTORE_PORT },
    "ui": { "enabled": false },
    "hub": { "port": $HUB_PORT }
  }
}
EOF

cat > "$EMU_DIR/.firebaserc" <<EOF
{ "projects": { "default": "$PROJECT" } }
EOF

echo "Starting the disposable Firestore emulator on port $FIRESTORE_PORT ..."
(
  cd "$EMU_DIR"
  exec "$FIREBASE" emulators:start \
    --only firestore \
    --project "$PROJECT"
) > "$EMU_DIR/emulator.log" 2>&1 &
EMU_PID=$!

ready=false
for _ in $(seq 1 90); do
  if curl -s -o /dev/null "http://127.0.0.1:$FIRESTORE_PORT/" && \
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

export FIRESTORE_EMULATOR_HOST="127.0.0.1:$FIRESTORE_PORT"
export GCLOUD_PROJECT="$PROJECT"
export GCLOUD_PROJECT_ID="$PROJECT"
export FIREBASE_CONFIG="{\"projectId\":\"$PROJECT\"}"

node --input-type=module - "$ROOT" <<'NODE'
import { createRequire } from 'node:module';
import path from 'node:path';

const root = process.argv[2];
const require = createRequire(path.join(root, 'functions', 'package.json'));
const adminApp = require('firebase-admin/app');
const firestore = require('firebase-admin/firestore');
adminApp.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = firestore.getFirestore();

await db.collection('rooms').doc('CLI-LEGACY-ROOM').set({
  roomId: 'CLI-LEGACY-ROOM',
  ownerId: 'CLI-OWNER',
  title: 'CLI legacy room',
  description: 'Disposable migration fixture',
  monthlyRent: 5000,
  securityDeposit: 10000,
  location: {
    address: '42 Exact Street',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560001',
    latitude: 12.9716,
    longitude: 77.5946,
  },
  latitude: 12.9716,
  longitude: 77.5946,
  roomType: 'single',
  furnishing: 'unfurnished',
  availableFrom: firestore.Timestamp.now(),
  amenities: [],
  occupancy: 2,
  currentOccupancy: 0,
  genderPreference: 'any',
  images: [],
  status: 'available',
  createdAt: firestore.Timestamp.now(),
  updatedAt: firestore.Timestamp.now(),
});
NODE

node "$ROOT/tools/private_location_migration.mjs" migrate --apply > "$EMU_DIR/migrate.json"
BEFORE_FINALIZE="$(node "$ROOT/tools/private_location_migration.mjs" verify --all)"
node -e '
  const report = JSON.parse(process.argv[1]);
  if (!report.readyToFinalize) throw new Error("the migrated database is not ready");
  if (report.scanned !== 1 || report.verified !== 1) {
    throw new Error(`unexpected verification counts: ${JSON.stringify(report)}`);
  }
' "$BEFORE_FINALIZE"

node "$ROOT/tools/private_location_migration.mjs" switch --enabled=true > /dev/null
node "$ROOT/tools/private_location_migration.mjs" switch --enabled=false > /dev/null

if node "$ROOT/tools/private_location_migration.mjs" switch --enabled=garbage \
  > "$EMU_DIR/invalid-switch.log" 2>&1; then
  echo "The CLI accepted an invalid compatibility-switch value." >&2
  exit 1
fi
if ! grep -q -- "--enabled=true or --enabled=false" \
  "$EMU_DIR/invalid-switch.log"; then
  echo "The invalid compatibility-switch error was not clear." >&2
  cat "$EMU_DIR/invalid-switch.log" >&2
  exit 1
fi

ROOM_LOCATION_STAGE=private \
  node "$ROOT/tools/private_location_migration.mjs" finalize --apply \
  > "$EMU_DIR/finalize.json"

AFTER_FINALIZE="$(node "$ROOT/tools/private_location_migration.mjs" verify --all)"
node -e '
  const report = JSON.parse(process.argv[1]);
  if (!report.readyToFinalize) throw new Error("the finalized database is not ready");
  if (report.publicExactRemaining !== 0) {
    throw new Error(`exact public fields remain: ${JSON.stringify(report)}`);
  }
' "$AFTER_FINALIZE"

if node "$ROOT/tools/private_location_migration.mjs" switch --enabled=true \
  > "$EMU_DIR/reopened-switch.log" 2>&1; then
  echo "The CLI reopened the compatibility switch after finalization." >&2
  exit 1
fi
if ! grep -q "cannot be reopened after finalization" \
  "$EMU_DIR/reopened-switch.log"; then
  echo "The finalized compatibility-switch guard was not enforced." >&2
  cat "$EMU_DIR/reopened-switch.log" >&2
  exit 1
fi

node --input-type=module - "$ROOT" <<'NODE'
import { createRequire } from 'node:module';
import path from 'node:path';

const root = process.argv[2];
const require = createRequire(path.join(root, 'functions', 'package.json'));
const adminApp = require('firebase-admin/app');
const firestore = require('firebase-admin/firestore');
adminApp.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = firestore.getFirestore();

const room = await db.collection('rooms').doc('CLI-LEGACY-ROOM').get();
const privateLocation = await db.collection('roomPrivate').doc('CLI-LEGACY-ROOM').get();
const config = await db.collection('system').doc('locationPrivacy').get();
const roomValue = room.data() || {};
const privateValue = privateLocation.data() || {};

if (!privateLocation.exists) throw new Error('the private location was not created');
if (privateValue.address !== '42 Exact Street') {
  throw new Error('the exact private address was not preserved');
}
if (roomValue.address !== undefined || roomValue.pincode !== undefined) {
  throw new Error('flat exact public fields remain');
}
if (roomValue.latitude !== undefined || roomValue.longitude !== undefined) {
  throw new Error('flat exact public coordinates remain');
}
if (roomValue.location?.address || roomValue.location?.pincode) {
  throw new Error('nested exact public fields remain');
}
if (roomValue.location?.city !== 'Bengaluru' || roomValue.location?.state !== 'Karnataka') {
  throw new Error('the coarse public location was not preserved');
}
if (config.get('finalized') !== true) {
  throw new Error('the durable finalization latch was not set');
}
if (config.get('allowClientExactLocationWrites') !== false) {
  throw new Error('the compatibility switch was not closed');
}
NODE

echo "Private-location CLI end-to-end regression passed."
