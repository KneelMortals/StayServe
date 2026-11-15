// Promote (or demote) a user to/from the `admin` role.
//
// The app itself can never hand out the first admin role:
//
//   * `registerUserRole` only lets a user claim `student` or `owner`.
//   * `setUserRole` refuses everybody who is not already an admin.
//   * The Firestore rules only let admins (or the cloud functions) write the
//     `role` field of a profile.
//
// So the very first admin has to be granted out of band — with this script.
//
//   node tools/make_admin.mjs --email you@example.com
//   node tools/make_admin.mjs --email you@example.com --role student
//   node tools/make_admin.mjs --list
//
// It writes BOTH halves that the app and the rules need:
//
//   1. the custom claim  {"role":"admin","admin":true}  (Firebase Auth)
//   2. the profile field users/{uid}.role = "admin"     (Cloud Firestore)
//
// Only one is not enough: the claim decides what the *rules* allow, the
// profile field decides what the *app* shows.
//
// Authentication: it reuses the OAuth token of the Firebase CLI, so the
// machine only needs `firebase login` — no service-account key.
//
//   npm i -g firebase-tools && firebase login
//
// The CLI token expires after about an hour; the script refreshes it by
// running a harmless CLI command first.

import os from 'os';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const PROJECT = 'myfirstapp-fa30f52b';
const FIREBASE = 'https://identitytoolkit.googleapis.com/v1';
const FIRESTORE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const VALID_ROLES = ['student', 'owner', 'admin'];

async function json(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

function firebaseToken() {
  // The firebase-tools access token expires after ~1h. Running any CLI
  // command makes the CLI refresh it (and write it back to the store),
  // so do that first and then read the fresh token.
  try {
    execFileSync('firebase', ['projects:list', '--project', PROJECT], {
      stdio: 'ignore',
      timeout: 120000,
    });
  } catch {
    // The CLI may not be on PATH in every environment; try the token anyway.
  }
  const p = path.join(os.homedir(), '.config/configstore/firebase-tools.json');
  const store = JSON.parse(fs.readFileSync(p, 'utf8'));
  const tok = store.tokens?.access_token;
  if (!tok) throw new Error('No firebase-tools OAuth token found at ' + p);
  return tok;
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const opts = { list: false, email: '', uid: '', role: 'admin' };

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--list' || arg === '-l') opts.list = true;
  else if (arg === '--email' || arg === '-e') opts.email = args[++i] || '';
  else if (arg === '--uid' || arg === '-u') opts.uid = args[++i] || '';
  else if (arg === '--role' || arg === '-r') opts.role = args[++i] || '';
  else if (arg === '--help' || arg === '-h') {
    console.log(
      'Usage:\n' +
        '  node tools/make_admin.mjs --email <email> [--role admin|student|owner]\n' +
        '  node tools/make_admin.mjs --uid <uid> [--role admin|student|owner]\n' +
        '  node tools/make_admin.mjs --list',
    );
    process.exit(0);
  } else if (!arg.startsWith('-')) {
    // A bare argument is treated as the e-mail address.
    opts.email = arg;
  }
}

if (!VALID_ROLES.includes(opts.role)) {
  console.error(`Invalid role "${opts.role}". Use one of: ${VALID_ROLES.join(', ')}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function listAccounts(token) {
  const res = await json(`${FIREBASE}/projects/${PROJECT}/accounts:query`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ returnUserInfo: true, maxResults: 1000 }),
  });
  if (res.status !== 200) {
    throw new Error(`accounts:query failed (HTTP ${res.status}): ${JSON.stringify(res.body).slice(0, 300)}`);
  }
  return res.body.userInfo || [];
}

async function findUid(token, { email, uid }) {
  if (uid) return uid;
  const users = await listAccounts(token);
  const match = users.find((u) => (u.email || '').toLowerCase() === email.toLowerCase());
  if (!match) {
    console.error(`No account with the e-mail address "${email}".`);
    console.error('Existing accounts:');
    for (const u of users) console.error('  ' + u.localId + '  ' + (u.email || '(no e-mail)'));
    process.exit(1);
  }
  return match.localId;
}

async function setClaims(token, uid, role) {
  // The v1 admin API writes the claims through `accounts:update` with the
  // uid in the **body** — `accounts/{uid}` does not exist as a method.
  const res = await json(`${FIREBASE}/projects/${PROJECT}/accounts:update`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      localId: uid,
      customAttributes: JSON.stringify({ role, admin: role === 'admin' }),
    }),
  });
  if (res.status !== 200) {
    throw new Error(`Could not set the custom claims (HTTP ${res.status}): ${JSON.stringify(res.body).slice(0, 300)}`);
  }
  return res.body;
}

async function writeProfileRole(token, uid, role) {
  const ref = `users/${uid}`;
  const current = await json(`${FIRESTORE}/${ref}`, { headers: authHeaders(token) });

  const fields = current.status === 200 ? current.body.fields || {} : {};

  const patch = {
    fields: {
      ...fields,
      uid: { stringValue: uid },
      role: { stringValue: role },
      updatedAt: { timestampValue: new Date().toISOString() },
    },
  };
  // A profile that does not exist yet needs the mandatory fields as well.
  if (!fields.email) patch.fields.email = { stringValue: '' };
  if (!fields.name) patch.fields.name = { stringValue: '' };
  if (!fields.createdAt) patch.fields.createdAt = { timestampValue: new Date().toISOString() };
  if (fields.isActive === undefined) patch.fields.isActive = { booleanValue: true };

  const res = await json(`${FIRESTORE}/${ref}`, {
    method: 'PATCH',
    headers: authHeaders(token),
    body: JSON.stringify(patch),
  });
  if (res.status !== 200) {
    throw new Error(`Could not write the profile (HTTP ${res.status}): ${JSON.stringify(res.body).slice(0, 300)}`);
  }
  return res.body;
}

async function revokeTokens(token, uid) {
  // The Identity Toolkit v1 REST API does not expose a "revoke the refresh
  // tokens" method (that only exists in the Admin SDK, which would need a
  // service-account key).
  //
  // It does not matter: the app calls `getIdToken(true)` on every start of
  // the session (`AuthRepository.refreshIdToken`), so the new claims are
  // picked up with the next launch or the next sign-in.
  return false;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const token = firebaseToken();

  if (opts.list) {
    const users = await listAccounts(token);
    console.log(`Accounts in ${PROJECT} (${users.length}):`);
    for (const u of users) {
      const claims = u.customAttributes ? JSON.parse(u.customAttributes) : {};
      console.log(
        `  ${u.localId}  ${(u.email || '(no e-mail)').padEnd(38)} role=${claims.role || '-'} admin=${claims.admin === true}`,
      );
    }
    return;
  }

  if (!opts.email && !opts.uid) {
    console.error('Nothing to do. Pass --email <address> (or --uid <uid>), or --list.');
    console.error('Usage: node tools/make_admin.mjs --email you@example.com');
    process.exit(1);
  }

  const uid = await findUid(token, opts);
  const who = opts.email || uid;

  console.log(`Setting the role of ${who} (uid ${uid}) to "${opts.role}" ...`);

  await setClaims(token, uid, opts.role);
  console.log('  custom claims set      -> {"role":"' + opts.role + '","admin":' + (opts.role === 'admin') + '}');

  await writeProfileRole(token, uid, opts.role);
  console.log('  users/' + uid + '.role written');

  const revoked = await revokeTokens(token, uid);
  console.log(
    revoked
      ? '  refresh tokens revoked   -> sign in again to pick up the new role'
      : '  the app refreshes the ID token on the next start -> sign out and in again',
  );

  console.log('');
  console.log('Done. Sign out of the app and sign in again — the new role is only');
  console.log('picked up with a fresh session.');
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
