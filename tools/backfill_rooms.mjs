// Backfill the server-owned listing fields on existing room documents.
//
// `rooms.status` and `rooms.currentOccupancy` are owned by the server:
// the status is changed by `setRoomListingAvailability` /
// `adminSetRoomListingStatus`, the counter by the booking state machine.
// A listing that was written without those fields (an older document, or one
// created by a client that left them out) is invisible to the student
// search, because a Firestore equality query (`status == available`) never
// matches a document that does not have the field.
//
// The script therefore fills in the two defaults **only when they are
// missing**:
//
//   * `currentOccupancy` -> 0
//   * `status`           -> `available` (or `occupied` when the listing is
//                           already full, which mirrors the booking state
//                           machine)
//
// A document that already carries a status is never changed — an `inactive`
// listing stays `inactive`.
//
//   node tools/backfill_rooms.mjs          # dry run (the default)
//   node tools/backfill_rooms.mjs --apply  # perform the backfill
//   node tools/backfill_rooms.mjs --project my-project
//
// Authentication reuses the Firebase CLI OAuth token, so the machine only
// needs `firebase login` — no service-account key is required.
//
// The write uses the document's `updateTime` as a precondition. If a listing
// changes between the read and the write, Firestore rejects that one update
// instead of overwriting a newer state.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DEFAULT_PROJECT = 'myfirstapp-fa30f52b';

const args = process.argv.slice(2);
const opts = {
  apply: false,
  project: DEFAULT_PROJECT,
  limit: 0,
};

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--apply') opts.apply = true;
  else if (arg === '--project') opts.project = String(args[++i] || '').trim();
  else if (arg === '--limit') opts.limit = Number(args[++i] || 0);
  else if (arg === '--help' || arg === '-h') {
    console.log(
      'Usage:\n' +
        '  node tools/backfill_rooms.mjs [--apply] [--project <id>] [--limit <n>]',
    );
    process.exit(0);
  } else {
    console.error(`Unknown argument: ${arg}`);
    process.exit(1);
  }
}

if (!opts.project) {
  console.error('--project needs a Firebase project id.');
  process.exit(1);
}
if (!Number.isInteger(opts.limit) || opts.limit < 0) {
  console.error('--limit must be a non-negative integer.');
  process.exit(1);
}

function firebaseToken() {
  // Running a harmless CLI command asks firebase-tools to refresh its OAuth
  // access token before it expires.
  try {
    execFileSync('firebase', ['projects:list', '--project', opts.project], {
      stdio: 'ignore',
      timeout: 120000,
    });
  } catch {
    // The CLI may not be installed or may not be logged in. The token file is
    // still tried below so a recent login can be used.
  }

  const stores = [
    path.join(os.homedir(), '.config', 'configstore', 'firebase-tools.json'),
    path.join(os.homedir(), '.config', 'firebase', 'config.json'),
  ];

  for (const store of stores) {
    if (!fs.existsSync(store)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(store, 'utf8'));
      const token = parsed?.tokens?.access_token;
      if (token) return token;
    } catch {
      // Try the next known location.
    }
  }

  throw new Error(
    'No firebase-tools OAuth token found. Run `firebase login` and try again.',
  );
}

async function json(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

function fieldValue(fields, name) {
  const field = fields?.[name];
  if (!field || typeof field !== 'object') return undefined;
  if ('stringValue' in field) return field.stringValue;
  if ('booleanValue' in field) return field.booleanValue;
  if ('integerValue' in field) return Number(field.integerValue);
  if ('doubleValue' in field) return field.doubleValue;
  if ('timestampValue' in field) return field.timestampValue;
  if ('nullValue' in field) return null;
  return undefined;
}

function documentId(name) {
  return String(name || '').split('/').pop() || '';
}

async function listRooms(token) {
  const base = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
    opts.project,
  )}/databases/(default)/documents/rooms`;
  const documents = [];
  let pageToken = '';

  do {
    const query = new URLSearchParams({ pageSize: '1000' });
    if (pageToken) query.set('pageToken', pageToken);
    const result = await json(`${base}?${query.toString()}`, {
      headers: authHeaders(token),
    });
    if (result.status !== 200) {
      throw new Error(
        `Could not list rooms (HTTP ${result.status}): ${JSON.stringify(
          result.body,
        ).slice(0, 400)}`,
      );
    }
    documents.push(...(result.body.documents || []));
    pageToken = result.body.nextPageToken || '';
  } while (pageToken);

  return documents;
}

function classify(documents) {
  const candidates = [];
  const complete = [];

  for (const doc of documents) {
    const fields = doc.fields || {};
    const status = fieldValue(fields, 'status');
    const currentOccupancy = fieldValue(fields, 'currentOccupancy');
    const occupancy = Number(fieldValue(fields, 'occupancy') || 1);
    const roomId = documentId(doc.name);

    const needsStatus = status === undefined || status === null;
    const needsOccupancy = currentOccupancy === undefined || currentOccupancy === null;

    if (!needsStatus && !needsOccupancy) {
      complete.push(roomId);
      continue;
    }

    // The counter is the truth: a listing that is already full is
    // `occupied`, everything else is on the market.
    const effectiveOccupancy =
      currentOccupancy === undefined || currentOccupancy === null
        ? 0
        : Number(currentOccupancy);
    const wantedStatus =
      effectiveOccupancy >= occupancy ? 'occupied' : 'available';

    candidates.push({
      roomId,
      title: String(fieldValue(fields, 'title') || ''),
      needsStatus,
      needsOccupancy,
      wantedStatus,
      updateTime: String(doc.updateTime || ''),
    });
  }

  return { candidates, complete };
}

async function patchRoom(token, candidate) {
  const fields = {};
  const updatePaths = [];

  if (candidate.needsStatus) {
    fields.status = { stringValue: candidate.wantedStatus };
    updatePaths.push('status');
  }
  if (candidate.needsOccupancy) {
    fields.currentOccupancy = { integerValue: '0' };
    updatePaths.push('currentOccupancy');
  }

  const query = updatePaths
    .map((fieldPath) => `updateMask.fieldPaths=${encodeURIComponent(fieldPath)}`)
    .join('&');
  let url =
    `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
      opts.project,
    )}/databases/(default)/documents/rooms/${encodeURIComponent(candidate.roomId)}` +
    `?${query}`;

  // The update-time precondition prevents a stale read from overwriting a
  // listing that changed after the list call.
  if (candidate.updateTime) {
    url += `&currentDocument.updateTime=${encodeURIComponent(
      candidate.updateTime,
    )}`;
  }

  return json(url, {
    method: 'PATCH',
    headers: authHeaders(token),
    body: JSON.stringify({ fields }),
  });
}

async function main() {
  const token = firebaseToken();
  const documents = await listRooms(token);
  const report = classify(documents);
  const candidates =
    opts.limit > 0 ? report.candidates.slice(0, opts.limit) : report.candidates;

  console.log(`Firebase project: ${opts.project}`);
  console.log(`Listings inspected: ${documents.length}`);
  console.log(`Already complete:   ${report.complete.length}`);
  console.log(`Legacy candidates:  ${candidates.length}`);

  for (const candidate of candidates) {
    const fields = [];
    if (candidate.needsStatus) fields.push(`status=${candidate.wantedStatus}`);
    if (candidate.needsOccupancy) fields.push('currentOccupancy=0');
    console.log(
      `  READY ${candidate.roomId} — "${candidate.title}" ${fields.join(' ')}`,
    );
  }

  if (!opts.apply) {
    console.log('\nDry run only. Re-run with --apply to write the fields.');
    return;
  }
  if (candidates.length === 0) {
    console.log('\nNothing to backfill.');
    return;
  }

  let updated = 0;
  let conflicts = 0;
  let failed = 0;

  for (const candidate of candidates) {
    const result = await patchRoom(token, candidate);
    if (result.status === 200) {
      updated++;
      console.log(`  DONE  ${candidate.roomId}`);
      continue;
    }

    if (result.status === 412 || result.status === 409) {
      conflicts++;
      console.log(
        `  RACE  ${candidate.roomId} — changed while it was being read; ` +
          'run the script again to review it',
      );
      continue;
    }

    failed++;
    console.error(
      `  FAIL  ${candidate.roomId} (HTTP ${result.status}): ${JSON.stringify(
        result.body,
      ).slice(0, 300)}`,
    );
  }

  console.log(
    `\nBackfill finished: ${updated} updated, ${conflicts} changed concurrently, ${failed} failed.`,
  );

  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('FAILED:', error.message);
  if (error && error.stack) console.error(error.stack);
  process.exit(1);
});
