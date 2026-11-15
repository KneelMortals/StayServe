// Backfill the server-owned registration marker on legacy user profiles.
//
// New accounts are created with `registrationCompleted: false` by the
// `onUserCreate` trigger and can only become usable after the server has
// verified the registration challenge. Accounts that existed before that
// marker was introduced do not have the field at all.
//
// This script marks only those **legacy** profiles as complete. It also
// restores a missing legacy `isActive: true` flag, because the server treats
// a missing active flag as disabled. A document that explicitly says
// `registrationCompleted: false` is a new, unfinished registration and is
// never changed by the script. An explicit `isActive: false` is likewise
// never re-enabled.
//
//   node tools/backfill_registration.mjs          # dry run (the default)
//   node tools/backfill_registration.mjs --apply  # perform the backfill
//   node tools/backfill_registration.mjs --project my-project
//
// Authentication reuses the Firebase CLI OAuth token, so the machine only
// needs `firebase login` — no service-account key is required.
//
// The write uses the document's `updateTime` as a precondition. If a profile
// changes between the read and the write, Firestore rejects that one update
// instead of overwriting a newer registration state.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DEFAULT_PROJECT = 'myfirstapp-fa30f52b';
const VALID_ROLES = new Set(['student', 'owner', 'admin']);

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
        '  node tools/backfill_registration.mjs [--apply] [--project <id>] [--limit <n>]',
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

async function listUsers(token) {
  const base = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
    opts.project,
  )}/databases/(default)/documents/users`;
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
        `Could not list users (HTTP ${result.status}): ${JSON.stringify(
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
  const alreadyComplete = [];
  const unfinished = [];
  const skipped = [];

  for (const doc of documents) {
    const fields = doc.fields || {};
    const marker = fieldValue(fields, 'registrationCompleted');
    const role = String(fieldValue(fields, 'role') || '').trim();
    const email = String(fieldValue(fields, 'email') || '').trim();
    const uid = String(fieldValue(fields, 'uid') || documentId(doc.name));
    const deletionScheduled = fieldValue(fields, 'deletionScheduled') === true;
    const active = fieldValue(fields, 'isActive');

    // Explicit false means the server created a new, unfinished account.
    // It must finish the OTP registration flow instead of being backfilled.
    if (marker === false) {
      unfinished.push(uid);
      continue;
    }

    if (deletionScheduled) {
      skipped.push({ uid, reason: 'deletion is scheduled' });
      continue;
    }
    if (!email) {
      skipped.push({ uid, reason: 'profile has no email address' });
      continue;
    }
    if (!VALID_ROLES.has(role)) {
      skipped.push({ uid, reason: `invalid or missing role "${role}"` });
      continue;
    }

    // A profile may already have the registration marker but still miss the
    // older `isActive` field. The server treats a missing active flag as
    // disabled, so that legacy shape has to be repaired as well.
    if (marker === true && active !== undefined) {
      alreadyComplete.push(uid);
      continue;
    }

    candidates.push({
      uid,
      role,
      needsRegistration: marker !== true,
      needsActive: active === undefined,
      updateTime: String(doc.updateTime || ''),
    });
  }

  return { candidates, alreadyComplete, unfinished, skipped };
}

async function markComplete(token, candidate) {
  const fields = {};
  const updatePaths = [];

  if (candidate.needsRegistration) {
    fields.registrationCompleted = { booleanValue: true };
    updatePaths.push('registrationCompleted');
  }
  if (candidate.needsActive) {
    fields.isActive = { booleanValue: true };
    updatePaths.push('isActive');
  }

  const query = updatePaths
    .map((path) => `updateMask.fieldPaths=${encodeURIComponent(path)}`)
    .join('&');
  let url =
    `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
      opts.project,
    )}/databases/(default)/documents/users/${encodeURIComponent(candidate.uid)}` +
    `?${query}`;

  // The update-time precondition prevents a stale read from overwriting a
  // profile that completed registration after the list call.
  if (candidate.updateTime) {
    url += `&currentDocument.updateTime=${encodeURIComponent(
      candidate.updateTime,
    )}`;
  }

  const result = await json(url, {
    method: 'PATCH',
    headers: authHeaders(token),
    body: JSON.stringify({ fields }),
  });

  return result;
}

async function main() {
  const token = firebaseToken();
  const documents = await listUsers(token);
  const report = classify(documents);
  const candidates =
    opts.limit > 0 ? report.candidates.slice(0, opts.limit) : report.candidates;

  console.log(`Firebase project: ${opts.project}`);
  console.log(`Profiles inspected: ${documents.length}`);
  console.log(`Already complete:   ${report.alreadyComplete.length}`);
  console.log(`New/unfinished:     ${report.unfinished.length}`);
  console.log(`Legacy candidates:  ${candidates.length}`);
  console.log(`Skipped:            ${report.skipped.length}`);

  for (const skipped of report.skipped) {
    console.log(`  SKIP  ${skipped.uid} — ${skipped.reason}`);
  }
  for (const candidate of candidates) {
    const fields = [];
    if (candidate.needsRegistration) fields.push('registrationCompleted');
    if (candidate.needsActive) fields.push('isActive');
    console.log(
      `  READY ${candidate.uid} — role=${candidate.role} fields=${fields.join('+')}`,
    );
  }

  if (!opts.apply) {
    console.log('\nDry run only. Re-run with --apply to write the marker.');
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
    const result = await markComplete(token, candidate);
    if (result.status === 200) {
      updated++;
      console.log(`  DONE  ${candidate.uid}`);
      continue;
    }

    if (result.status === 412 || result.status === 409) {
      conflicts++;
      console.log(
        `  RACE  ${candidate.uid} — changed while it was being read; ` +
          'run the script again to review it',
      );
      continue;
    }

    failed++;
    console.error(
      `  FAIL  ${candidate.uid} (HTTP ${result.status}): ${JSON.stringify(
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
  // The stack makes a failure in the script itself (a typo, a reassignment
  // of a constant) visible instead of only its message.
  if (error && error.stack) console.error(error.stack);
  process.exit(1);
});
