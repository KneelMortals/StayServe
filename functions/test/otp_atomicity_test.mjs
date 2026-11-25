// Focused regression tests for the atomic OTP attempt and challenge rules.
//
//   npm run build
//   node test/otp_atomicity_test.mjs
//
// The callable is loaded from the compiled output with a small in-memory
// Firestore double. Its transactions use optimistic concurrency: readers
// may see the same document version, but a conflicting commit is retried.
// This is the contention which the production Firestore transaction has to
// protect the five-attempt limit and the one-time challenge.

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let pass = 0;
let fail = 0;
const failures = [];

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    failures.push(label);
    console.log(
      `  FAIL  ${label}  expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`,
    );
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function clone(value) {
  if (value instanceof FakeTimestamp) {
    return new FakeTimestamp(value.milliseconds);
  }
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') {
    const copy = {};
    for (const [key, item] of Object.entries(value)) copy[key] = clone(item);
    return copy;
  }
  return value;
}

class FakeTimestamp {
  constructor(milliseconds) {
    this.milliseconds = milliseconds;
  }

  toMillis() {
    return this.milliseconds;
  }
}

/**
 * Resolves the serverTimestamp marker exactly as Firestore does when a
 * transaction commits. Without this, a transaction retry would read the
 * marker as a malformed timestamp and reset the quota window.
 */
function materializeServerTimestamps(value) {
  if (value instanceof FakeTimestamp) return value;
  if (Array.isArray(value)) return value.map(materializeServerTimestamps);
  if (value && typeof value === 'object') {
    const candidate = /** @type {any} */ (value);
    if (
      candidate.serverTimestamp === true &&
      Object.keys(candidate).length === 1
    ) {
      return new FakeTimestamp(Date.now());
    }
    const materialized = {};
    for (const [key, item] of Object.entries(value)) {
      materialized[key] = materializeServerTimestamps(item);
    }
    return materialized;
  }
  return value;
}

class FakeSnapshot {
  constructor(data) {
    this.exists = data !== undefined;
    this._data = data;
  }

  data() {
    return clone(this._data ?? {});
  }

  get(field) {
    return this.exists ? clone(this._data?.[field]) : undefined;
  }
}

class TransactionConflict extends Error {}

class FakeTransaction {
  constructor(db, attempt) {
    this.db = db;
    this.attempt = attempt;
    this.reads = new Map();
    this.writes = new Map();
    this.startVersions = new Map(db.versions);
  }

  async get(ref) {
    const version = this.db.versions.get(ref.path) ?? 0;
    const data = this.db.docs.has(ref.path)
      ? clone(this.db.docs.get(ref.path))
      : undefined;
    this.reads.set(ref.path, { version });

    const barrier = this.db.barriers.get(ref.path);
    if (barrier && this.attempt === 0) await barrier.wait();

    return new FakeSnapshot(data);
  }

  async getAll(...refs) {
    const list =
      refs.length === 1 && Array.isArray(refs[0]) ? refs[0] : refs;
    return Promise.all(list.map((ref) => this.get(ref)));
  }

  set(ref, data, options = {}) {
    if (this.db.failWrites.has(ref.path)) {
      throw new Error(`simulated write failure for ${ref.path}`);
    }
    this.writes.set(ref.path, { data: clone(data), options });
  }

  delete(ref) {
    if (this.db.failWrites.has(ref.path)) {
      throw new Error(`simulated write failure for ${ref.path}`);
    }
    this.writes.set(ref.path, { delete: true });
  }
}

class FakeFirestore {
  constructor() {
    this.docs = new Map();
    this.versions = new Map();
    this.barriers = new Map();
    this.failWrites = new Set();
  }

  reset() {
    this.docs.clear();
    this.versions.clear();
    this.barriers.clear();
    this.failWrites.clear();
  }

  collection(name) {
    return {
      doc: (id) => ({
        path: `${name}/${id}`,
        get: async () => this.snapshot(`${name}/${id}`),
        set: async (data, options = {}) =>
          this.writeDirect(`${name}/${id}`, data, options),
      }),
    };
  }

  seed(path, data) {
    this.docs.set(path, clone(data));
    this.versions.set(path, 0);
  }

  snapshot(path) {
    const data = this.docs.has(path) ? clone(this.docs.get(path)) : undefined;
    return new FakeSnapshot(data);
  }

  writeDirect(path, data, options = {}) {
    const current = this.docs.get(path);
    const materialized = materializeServerTimestamps(data);
    const next = options.merge
      ? { ...(current ?? {}), ...clone(materialized) }
      : clone(materialized);
    this.docs.set(path, next);
    this.versions.set(path, (this.versions.get(path) ?? 0) + 1);
  }

  // Hold the first `count` readers until all of them have observed the same
  // document version. A later transaction retry passes through immediately.
  setReadBarrier(path, count) {
    let release;
    let waiting = 0;
    let released = false;
    const ready = new Promise((resolve) => {
      release = resolve;
    });

    this.barriers.set(path, {
      wait: async () => {
        if (released) return;
        waiting++;
        if (waiting >= count) {
          released = true;
          release();
        }
        await ready;
      },
    });
  }

  async runTransaction(updateFunction) {
    let attempt = 0;

    for (;;) {
      const transaction = new FakeTransaction(this, attempt);
      try {
        const result = await updateFunction(transaction);
        this.commit(transaction);
        return result;
      } catch (error) {
        if (!(error instanceof TransactionConflict) || attempt >= 100) {
          throw error;
        }
        attempt++;
      }
    }
  }

  commit(transaction) {
    for (const [path, write] of transaction.writes) {
      const read = transaction.reads.get(path);
      const currentVersion = this.versions.get(path) ?? 0;
      const observedVersion = read
        ? read.version
        : (transaction.startVersions.get(path) ?? 0);
      if (observedVersion !== currentVersion) {
        throw new TransactionConflict(path);
      }
    }

    for (const [path, write] of transaction.writes) {
      if (write.delete) {
        this.docs.delete(path);
        this.versions.set(path, (this.versions.get(path) ?? 0) + 1);
      } else {
        this.writeDirect(path, write.data, write.options);
      }
    }
  }
}

class FakeHttpsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HttpsError';
    this.code = code;
  }
}

const db = new FakeFirestore();
const authCalls = [];
let failNextClaim = false;

const firestoreMock = {
  getFirestore: () => db,
  FieldValue: {
    serverTimestamp: () => ({ serverTimestamp: true }),
  },
  Timestamp: {
    fromMillis: (milliseconds) => new FakeTimestamp(milliseconds),
  },
};

const revokeCalls = [];
// Registration reads the live Firebase Auth record. The focused test double
// supplies the same unverified email which the synthetic token carries so the
// legacy one-time-email challenge remains the proof of registration.
const authUserEmails = new Map([
  ['first-user', 'one-time-challenge@example.com'],
  ['second-user', 'one-time-challenge@example.com'],
  ['failed-registration', 'atomic-profile@example.com'],
  ['claim-retry-user', 'atomic-claim-retry@example.com'],
  ['role-claim-user', 'role-claim@example.com'],
  ['atomic-role-user', 'atomic-role-claim@example.com'],
  ['claim-convergence-user', 'claim-convergence@example.com'],
]);
const authClient = {
  getUser: async (uid) => {
    const email = authUserEmails.get(uid) || '';
    return {
      uid,
      email,
      emailVerified: false,
      phoneNumber: null,
      providerData: email ? [{ providerId: 'password' }] : [],
    };
  },
  setCustomUserClaims: async (uid, claims) => {
    if (failNextClaim) {
      failNextClaim = false;
      throw new Error('simulated Auth claim failure');
    }
    authCalls.push({ uid, claims });
  },
  revokeRefreshTokens: async (uid) => {
    revokeCalls.push(uid);
  },
};

const authMock = {
  getAuth: () => authClient,
};

const httpsMock = {
  HttpsError: FakeHttpsError,
  onCall: (handler) => ({ run: handler }),
};

const functionsMock = {
  https: httpsMock,
  // The App Check wrapper builds the callable surface through `runWith`.
  runWith: () => ({ https: httpsMock }),
  pubsub: {
    schedule: () => ({
      onRun: (handler) => ({ run: handler }),
    }),
  },
};

// Load the compiled callable with only the Firebase boundaries replaced.
const Module = require('node:module');
// `_load` is an undocumented Node internal used only by this test double.
// Keep the cast local so enabling checkJs does not report the private API.
/** @type {any} */
const moduleLoader = Module;
const originalLoad = moduleLoader._load;
moduleLoader._load = function mockFirebaseModule(request, parent, isMain) {
  if (request === 'firebase-functions/v1') return functionsMock;
  if (request === 'firebase-admin/firestore') return firestoreMock;
  if (request === 'firebase-admin/auth') return authMock;
  if (request === 'firebase-admin/app') {
    return { initializeApp: () => ({}) };
  }
  return originalLoad.call(this, request, parent, isMain);
};

let otp;
try {
  otp = require(path.join(HERE, '..', 'lib', 'otp.js'));
} finally {
  moduleLoader._load = originalLoad;
}

function otpDocumentId(channel, identifier) {
  return `${channel}_${sha256(identifier.toLowerCase())}`;
}

function errorCode(result) {
  return result.status === 'rejected' ? result.reason?.code : undefined;
}

function countOutcomes(results, code) {
  return results.filter((result) => errorCode(result) === code).length;
}

section('parallel OTP guesses cannot bypass the attempt limit');

{
  db.reset();
  authCalls.length = 0;

  const identifier = 'atomic-attempts@example.com';
  const otpPath = `otpCodes/${otpDocumentId('email', identifier)}`;
  const salt = 'test-salt';
  db.seed(otpPath, {
    channel: 'email',
    identifierHash: sha256(identifier),
    codeHash: sha256(`123456:${salt}`),
    salt,
    attempts: 0,
    verified: false,
    expiresAt: new FakeTimestamp(Date.now() + 5 * 60 * 1000),
    challengeUsed: false,
  });

  // Six guesses all start from the same version. Firestore must serialize
  // their writes: five are checked and the sixth exhausts the limit.
  db.setReadBarrier(otpPath, 6);
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, () =>
      otp.verifyOtp.run(
        {
          channel: 'email',
          identifier,
          otp: '000000',
        },
        { auth: null, rawRequest: { ip: '127.0.0.1' } },
      ),
    ),
  );

  check(
    'exactly five parallel guesses are checked against the code',
    countOutcomes(results, 'invalid-argument'),
    5,
  );
  check(
    'the sixth parallel guess exhausts the five-attempt limit',
    countOutcomes(results, 'resource-exhausted'),
    1,
  );
  check(
    'the atomic counter records every serialized guess',
    db.docs.get(otpPath)?.attempts,
    6,
  );

  const correctAfterLimit = await Promise.allSettled([
    otp.verifyOtp.run(
      { channel: 'email', identifier, otp: '123456' },
      { auth: null, rawRequest: { ip: '127.0.0.1' } },
    ),
  ]);
  check(
    'a correct code cannot bypass the exhausted attempt limit',
    errorCode(correctAfterLimit[0]),
    'resource-exhausted',
  );
}

section('a consumed verification challenge can be renewed only with the active OTP');

{
  db.reset();
  const identifier = 'renewal-proof@example.com';
  const otpPath = `otpCodes/${otpDocumentId('email', identifier)}`;
  const salt = 'renewal-salt';
  const oldChallenge = 'old-consumed-challenge';
  db.seed(otpPath, {
    channel: 'email',
    identifierHash: sha256(identifier),
    codeHash: sha256(`654321:${salt}`),
    salt,
    attempts: 1,
    verified: true,
    verifiedByUid: 'renewal-user',
    verifiedAt: new FakeTimestamp(Date.now() - 60 * 1000),
    expiresAt: new FakeTimestamp(Date.now() + 5 * 60 * 1000),
    challengeHash: sha256(oldChallenge),
    challengeIssuedAt: new FakeTimestamp(Date.now() - 60 * 1000),
    challengeExpiresAt: new FakeTimestamp(Date.now() + 5 * 60 * 1000),
    challengeUsed: true,
  });

  const wrong = await Promise.allSettled([
    otp.verifyOtp.run(
      { channel: 'email', identifier, otp: '111111' },
      {
        auth: { uid: 'renewal-user', token: {} },
        rawRequest: { ip: '127.0.0.1' },
      },
    ),
  ]);
  check(
    'a consumed verification cannot be renewed without the active OTP',
    errorCode(wrong[0]),
    'invalid-argument',
  );
  check(
    'the failed renewal counts one OTP attempt',
    db.docs.get(otpPath)?.attempts,
    2,
  );
  check(
    'the failed renewal keeps the consumed challenge',
    db.docs.get(otpPath)?.challengeHash,
    sha256(oldChallenge),
  );

  const correct = await Promise.allSettled([
    otp.verifyOtp.run(
      { channel: 'email', identifier, otp: '654321' },
      {
        auth: { uid: 'renewal-user', token: {} },
        rawRequest: { ip: '127.0.0.1' },
      },
    ),
  ]);
  const renewed = correct[0].status === 'fulfilled' ? correct[0].value : null;
  check('the active OTP renews the bound challenge', renewed?.alreadyVerified, true);
  check(
    'the renewed challenge is different from the consumed challenge',
    renewed?.challenge && renewed.challenge !== oldChallenge,
    true,
  );
  check(
    'the renewed challenge is stored for the next registration attempt',
    db.docs.get(otpPath)?.challengeHash,
    sha256(renewed?.challenge || ''),
  );
}

section('a registration challenge is consumed by only one account');

{
  db.reset();
  authCalls.length = 0;

  const identifier = 'one-time-challenge@example.com';
  const challenge = 'one-time-challenge-value';
  const otpPath = `otpCodes/${otpDocumentId('email', identifier)}`;
  db.seed(otpPath, {
    channel: 'email',
    identifierHash: sha256(identifier),
    attempts: 1,
    verified: true,
    verifiedByUid: null,
    challengeHash: sha256(challenge),
    challengeIssuedAt: new FakeTimestamp(Date.now()),
    challengeExpiresAt: new FakeTimestamp(Date.now() + 10 * 60 * 1000),
    challengeUsed: false,
  });

  // Two different accounts race to use the same challenge. Reading and
  // consuming it must be one atomic operation.
  db.setReadBarrier(otpPath, 2);
  const registrations = await Promise.allSettled([
    otp.completeRegistration.run(
      { name: 'First Account', role: 'student', challenge },
      {
        auth: { uid: 'first-user', token: { email: identifier } },
        rawRequest: { ip: '127.0.0.1' },
      },
    ),
    otp.completeRegistration.run(
      { name: 'Second Account', role: 'student', challenge },
      {
        auth: { uid: 'second-user', token: { email: identifier } },
        rawRequest: { ip: '127.0.0.1' },
      },
    ),
  ]);

  check(
    'one concurrent registration accepts the challenge',
    registrations.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  check(
    'the other concurrent registration is refused',
    countOutcomes(registrations, 'failed-precondition'),
    1,
  );
  check(
    'the challenge is marked as consumed',
    db.docs.get(otpPath)?.challengeUsed,
    true,
  );
  check(
    'exactly one account profile is registered',
    ['first-user', 'second-user'].filter(
      (uid) => db.docs.get(`users/${uid}`)?.registrationCompleted === true,
    ).length,
    1,
  );
  const registeredUid = ['first-user', 'second-user'].find(
    (uid) => db.docs.get(`users/${uid}`)?.registrationCompleted === true,
  );
  check(
    'the consumed OTP record is bound to the registered account',
    db.docs.get(otpPath)?.verifiedByUid,
    registeredUid,
  );
  const registeredProfile = db.docs.get(`users/${registeredUid}`);
  check(
    'the legacy email proof does not impersonate Firebase Auth verification',
    registeredProfile?.emailVerified,
    false,
  );
  check(
    'the legacy email proof is retained under its separate source marker',
    registeredProfile?.legacyEmailProofSource,
    'stayServeOtp',
  );
  check(
    'the legacy proof marker names the address which it proved',
    registeredProfile?.legacyEmailProofEmail,
    identifier,
  );
  check(
    'custom claims are written for exactly one account',
    authCalls.length,
    1,
  );
}

section('a failed profile write does not consume the OTP challenge');

{
  db.reset();
  authCalls.length = 0;
  failNextClaim = false;

  const identifier = 'atomic-profile@example.com';
  const challenge = 'atomic-profile-challenge';
  const otpPath = `otpCodes/${otpDocumentId('email', identifier)}`;
  db.seed(otpPath, {
    channel: 'email',
    identifierHash: sha256(identifier),
    attempts: 1,
    verified: true,
    verifiedByUid: null,
    challengeHash: sha256(challenge),
    challengeIssuedAt: new FakeTimestamp(Date.now()),
    challengeExpiresAt: new FakeTimestamp(Date.now() + 10 * 60 * 1000),
    challengeUsed: false,
  });
  db.failWrites.add('users/failed-registration');

  const result = await Promise.allSettled([
    otp.completeRegistration.run(
      { name: 'Failed Account', role: 'student', challenge },
      {
        auth: { uid: 'failed-registration', token: { email: identifier } },
        rawRequest: { ip: '127.0.0.1' },
      },
    ),
  ]);

  check('the failed registration is rejected', result[0].status, 'rejected');
  check(
    'the OTP challenge remains available after the profile failure',
    db.docs.get(otpPath)?.challengeUsed,
    false,
  );
  check(
    'the failed registration did not create a profile',
    db.docs.get('users/failed-registration'),
    undefined,
  );
  check('the failed registration did not write Auth claims', authCalls.length, 0);
}

section('an Auth claim failure can be retried without a fresh OTP');

{
  db.reset();
  authCalls.length = 0;
  failNextClaim = false;

  const identifier = 'atomic-claim-retry@example.com';
  const challenge = 'atomic-claim-retry-challenge';
  const otpPath = `otpCodes/${otpDocumentId('email', identifier)}`;
  db.seed(otpPath, {
    channel: 'email',
    identifierHash: sha256(identifier),
    attempts: 1,
    verified: true,
    verifiedByUid: null,
    challengeHash: sha256(challenge),
    challengeIssuedAt: new FakeTimestamp(Date.now()),
    challengeExpiresAt: new FakeTimestamp(Date.now() + 10 * 60 * 1000),
    challengeUsed: false,
  });

  failNextClaim = true;
  const firstAttempt = await Promise.allSettled([
    otp.completeRegistration.run(
      { name: 'Retry Account', role: 'student', challenge },
      {
        auth: { uid: 'claim-retry-user', token: { email: identifier } },
        rawRequest: { ip: '127.0.0.1' },
      },
    ),
  ]);
  check('the first registration reports the Auth failure', firstAttempt[0].status, 'rejected');
  check(
    'the Firestore profile was committed before the Auth failure',
    db.docs.get('users/claim-retry-user')?.registrationCompleted,
    true,
  );
  check(
    'the challenge was consumed by the committed profile',
    db.docs.get(otpPath)?.challengeUsed,
    true,
  );

  const retry = await Promise.allSettled([
    otp.completeRegistration.run(
      { name: 'Retry Account', role: 'student', challenge },
      {
        auth: { uid: 'claim-retry-user', token: { email: identifier } },
        rawRequest: { ip: '127.0.0.1' },
      },
    ),
  ]);
  check('the idempotent retry succeeds', retry[0].status, 'fulfilled');
  check('the retry writes the missing Auth claim', authCalls.length, 1);
  check(
    'the retry keeps the registered role',
    retry[0].status === 'fulfilled' ? retry[0].value.role : null,
    'student',
  );
}

section('registerUserRole requires one matching unused challenge');

{
  const seedRoleClaim = ({ challengeUsed = false } = {}) => {
    db.reset();
    authCalls.length = 0;
    failNextClaim = false;

    const identifier = 'role-claim@example.com';
    const challenge = 'role-claim-challenge';
    const otpPath = `otpCodes/${otpDocumentId('email', identifier)}`;
    db.seed(otpPath, {
      channel: 'email',
      identifierHash: sha256(identifier),
      attempts: 1,
      verified: true,
      verifiedByUid: 'role-claim-user',
      challengeHash: sha256(challenge),
      challengeIssuedAt: new FakeTimestamp(Date.now()),
      challengeExpiresAt: new FakeTimestamp(Date.now() + 10 * 60 * 1000),
      challengeUsed,
    });
    db.seed('users/role-claim-user', {
      uid: 'role-claim-user',
      role: 'student',
      roleClaimed: false,
      roleRevision: 0,
      registrationCompleted: false,
      isActive: true,
    });
    return { identifier, challenge, otpPath };
  };

  const runRoleClaim = (challenge, role = 'owner') =>
    otp.registerUserRole.run(
      { role, challenge },
      {
        auth: {
          uid: 'role-claim-user',
          token: { email: 'role-claim@example.com' },
        },
        rawRequest: { ip: '127.0.0.1' },
      },
    );

  let seeded = seedRoleClaim();
  const missing = await Promise.allSettled([runRoleClaim('')]);
  check(
    'a role claim without a challenge is refused',
    errorCode(missing[0]),
    'failed-precondition',
  );
  check(
    'the missing challenge did not consume the verification',
    db.docs.get(seeded.otpPath)?.challengeUsed,
    false,
  );

  seeded = seedRoleClaim();
  const stale = await Promise.allSettled([runRoleClaim('stale-challenge')]);
  check(
    'a role claim with a stale challenge is refused',
    errorCode(stale[0]),
    'failed-precondition',
  );
  check(
    'the stale challenge did not consume the verification',
    db.docs.get(seeded.otpPath)?.challengeUsed,
    false,
  );
  check(
    'the stale challenge did not change the role',
    db.docs.get('users/role-claim-user')?.role,
    'student',
  );
  check('the stale challenge wrote no Auth claim', authCalls.length, 0);

  seeded = seedRoleClaim({ challengeUsed: true });
  const consumed = await Promise.allSettled([runRoleClaim(seeded.challenge)]);
  check(
    'an already consumed challenge is refused',
    errorCode(consumed[0]),
    'failed-precondition',
  );
  check(
    'the consumed challenge did not change the role',
    db.docs.get('users/role-claim-user')?.role,
    'student',
  );
  check('the consumed challenge wrote no Auth claim', authCalls.length, 0);
}

section('registerUserRole consumes its challenge atomically');

{
  db.reset();
  authCalls.length = 0;
  failNextClaim = false;

  const identifier = 'atomic-role-claim@example.com';
  const challenge = 'atomic-role-claim-challenge';
  const otpPath = `otpCodes/${otpDocumentId('email', identifier)}`;
  db.seed(otpPath, {
    channel: 'email',
    identifierHash: sha256(identifier),
    attempts: 1,
    verified: true,
    verifiedByUid: 'atomic-role-user',
    challengeHash: sha256(challenge),
    challengeIssuedAt: new FakeTimestamp(Date.now()),
    challengeExpiresAt: new FakeTimestamp(Date.now() + 10 * 60 * 1000),
    challengeUsed: false,
  });
  db.seed('users/atomic-role-user', {
    uid: 'atomic-role-user',
    role: 'student',
    roleClaimed: false,
    roleRevision: 0,
    registrationCompleted: false,
    isActive: true,
  });

  db.setReadBarrier(otpPath, 2);
  const claims = await Promise.allSettled([
    otp.registerUserRole.run(
      { role: 'owner', challenge },
      {
        auth: {
          uid: 'atomic-role-user',
          token: { email: identifier },
        },
        rawRequest: { ip: '127.0.0.1' },
      },
    ),
    otp.registerUserRole.run(
      { role: 'student', challenge },
      {
        auth: {
          uid: 'atomic-role-user',
          token: { email: identifier },
        },
        rawRequest: { ip: '127.0.0.1' },
      },
    ),
  ]);

  check(
    'only one concurrent role claim succeeds',
    claims.filter((result) => result.status === 'fulfilled').length,
    1,
  );
  check(
    'the losing concurrent role claim is refused',
    countOutcomes(claims, 'failed-precondition'),
    1,
  );
  check(
    'the challenge was consumed by the successful role claim',
    db.docs.get(otpPath)?.challengeUsed,
    true,
  );
  check(
    'the consumed verification is bound to the claiming account',
    db.docs.get(otpPath)?.verifiedByUid,
    'atomic-role-user',
  );
  check(
    'the successful role claim is marked as claimed',
    db.docs.get('users/atomic-role-user')?.roleClaimed,
    true,
  );
  check(
    'exactly one role claim was published to Auth',
    authCalls.length,
    1,
  );
  check(
    'the published claim contains the selected role',
    authCalls[0]?.claims?.role,
    db.docs.get('users/atomic-role-user')?.role,
  );
  check(
    'the published claim contains the role revision',
    authCalls[0]?.claims?.roleRevision,
    db.docs.get('users/atomic-role-user')?.roleRevision,
  );
}

section('role-claim publication converges on a newer live role');

{
  db.reset();
  authCalls.length = 0;
  revokeCalls.length = 0;
  failNextClaim = false;

  const identifier = 'claim-convergence@example.com';
  const challenge = 'claim-convergence-challenge';
  const otpPath = `otpCodes/${otpDocumentId('email', identifier)}`;
  db.seed(otpPath, {
    channel: 'email',
    identifierHash: sha256(identifier),
    attempts: 1,
    verified: true,
    verifiedByUid: 'claim-convergence-user',
    challengeHash: sha256(challenge),
    challengeIssuedAt: new FakeTimestamp(Date.now()),
    challengeExpiresAt: new FakeTimestamp(Date.now() + 10 * 60 * 1000),
    challengeUsed: false,
  });

  const originalSetClaims = authClient.setCustomUserClaims;
  authClient.setCustomUserClaims = async (uid, claims) => {
    await originalSetClaims(uid, claims);
    if (uid === 'claim-convergence-user' && claims.role === 'student') {
      const current = db.docs.get(`users/${uid}`) || {};
      db.writeDirect(`users/${uid}`, {
        ...current,
        role: 'owner',
        roleRevision: 9,
      });
    }
  };

  try {
    const registration = await Promise.allSettled([
      otp.completeRegistration.run(
        { name: 'Convergence Account', role: 'student', challenge },
        {
          auth: {
            uid: 'claim-convergence-user',
            token: { email: identifier },
          },
          rawRequest: { ip: '127.0.0.1' },
        },
      ),
    ]);
    check(
      'the registration succeeds while the role changes concurrently',
      registration[0].status,
      'fulfilled',
    );
  } finally {
    authClient.setCustomUserClaims = originalSetClaims;
  }

  check(
    'the stale registration claim was written once',
    authCalls.filter((call) => call.claims?.role === 'student').length,
    1,
  );
  check(
    'the newer live role was published afterwards',
    authCalls.at(-1)?.claims?.role,
    'owner',
  );
  check(
    'the published claim contains the newer role revision',
    authCalls.at(-1)?.claims?.roleRevision,
    9,
  );
  check(
    'the final live profile keeps the newer role revision',
    db.docs.get('users/claim-convergence-user')?.roleRevision,
    9,
  );
  check(
    'registration kept the refresh session which fetches the new claim',
    revokeCalls.length,
    0,
  );
}

section('the IP and account OTP quotas are enforced together');

{
  const providerVariables = [
    'SENDGRID_API_KEY',
    'RESEND_API_KEY',
    'BREVO_API_KEY',
    'SMTP_HOST',
    'TWILIO_ACCOUNT_SID',
    'FAST2SMS_API_KEY',
    'MSG91_AUTH_KEY',
  ];
  const previousProviders = Object.fromEntries(
    providerVariables.map((name) => [name, process.env[name]]),
  );
  for (const name of providerVariables) delete process.env[name];

  try {
    db.reset();
    const ip = '203.0.113.42';
    const uid = 'quota-user';
    const ipQuotaPath = `otpSendQuota/ip_${sha256(ip)}`;
    const uidQuotaPath = `otpSendQuota/uid_${sha256(uid)}`;

    const accepted = await Promise.allSettled([
      otp.sendOtp.run(
        {
          channel: 'email',
          identifier: 'quota-success@example.com',
        },
        { auth: { uid }, rawRequest: { ip } },
      ),
    ]);
    check('a first signed-in send is accepted', accepted[0].status, 'fulfilled');
    check(
      'the IP quota was incremented',
      db.docs.get(ipQuotaPath)?.sendCount,
      1,
    );
    check(
      'the account quota was incremented',
      db.docs.get(uidQuotaPath)?.sendCount,
      1,
    );
    check(
      'the committed IP quota has a real timestamp',
      typeof db.docs.get(ipQuotaPath)?.windowStart?.toMillis === 'function',
      true,
    );

    db.reset();
    db.seed(ipQuotaPath, {
      sendCount: 20,
      windowStart: new FakeTimestamp(Date.now()),
    });
    const ipExhausted = await Promise.allSettled([
      otp.sendOtp.run(
        {
          channel: 'email',
          identifier: 'quota-ip-exhausted@example.com',
        },
        { auth: { uid }, rawRequest: { ip } },
      ),
    ]);
    check(
      'an exhausted IP quota rejects the send',
      errorCode(ipExhausted[0]),
      'resource-exhausted',
    );
    check(
      'the rejected send did not increment the account quota',
      db.docs.get(uidQuotaPath)?.sendCount ?? 0,
      0,
    );

    db.reset();
    db.seed(uidQuotaPath, {
      sendCount: 20,
      windowStart: new FakeTimestamp(Date.now()),
    });
    const uidExhausted = await Promise.allSettled([
      otp.sendOtp.run(
        {
          channel: 'email',
          identifier: 'quota-account-exhausted@example.com',
        },
        { auth: { uid }, rawRequest: { ip } },
      ),
    ]);
    check(
      'an exhausted account quota rejects the send',
      errorCode(uidExhausted[0]),
      'resource-exhausted',
    );
    check(
      'the rejected send did not increment the IP quota',
      db.docs.get(ipQuotaPath)?.sendCount ?? 0,
      0,
    );

    db.reset();
    db.seed(ipQuotaPath, {
      sendCount: 19,
      windowStart: new FakeTimestamp(Date.now()),
    });
    db.setReadBarrier(ipQuotaPath, 2);
    const parallelIp = await Promise.allSettled([
      otp.sendOtp.run(
        {
          channel: 'email',
          identifier: 'parallel-ip-a@example.com',
        },
        { auth: null, rawRequest: { ip } },
      ),
      otp.sendOtp.run(
        {
          channel: 'email',
          identifier: 'parallel-ip-b@example.com',
        },
        { auth: null, rawRequest: { ip } },
      ),
    ]);
    check(
      'parallel sends cannot both pass the last shared IP quota slot',
      parallelIp.filter((result) => result.status === 'fulfilled').length,
      1,
    );
    check(
      'the losing parallel IP send is rate limited',
      countOutcomes(parallelIp, 'resource-exhausted'),
      1,
    );
    check(
      'the shared IP quota never exceeds its limit',
      db.docs.get(ipQuotaPath)?.sendCount,
      20,
    );

    db.reset();
    db.seed(uidQuotaPath, {
      sendCount: 19,
      windowStart: new FakeTimestamp(Date.now()),
    });
    db.setReadBarrier(uidQuotaPath, 2);
    const parallelUid = await Promise.allSettled([
      otp.sendOtp.run(
        {
          channel: 'email',
          identifier: 'parallel-account-a@example.com',
        },
        { auth: { uid }, rawRequest: { ip: '203.0.113.51' } },
      ),
      otp.sendOtp.run(
        {
          channel: 'email',
          identifier: 'parallel-account-b@example.com',
        },
        { auth: { uid }, rawRequest: { ip: '203.0.113.52' } },
      ),
    ]);
    check(
      'parallel sends cannot both pass the last shared account quota slot',
      parallelUid.filter((result) => result.status === 'fulfilled').length,
      1,
    );
    check(
      'the losing parallel account send is rate limited',
      countOutcomes(parallelUid, 'resource-exhausted'),
      1,
    );
    check(
      'the shared account quota never exceeds its limit',
      db.docs.get(uidQuotaPath)?.sendCount,
      20,
    );

    db.reset();
    const parallelAddressPath = `otpCodes/${otpDocumentId(
      'email',
      'parallel-address@example.com',
    )}`;
    db.seed(parallelAddressPath, {
      channel: 'email',
      identifierHash: sha256('parallel-address@example.com'),
      attempts: 0,
      verified: false,
      expiresAt: new FakeTimestamp(Date.now() + 5 * 60 * 1000),
      windowStart: new FakeTimestamp(Date.now()),
      sendCount: 4,
      challengeUsed: false,
    });
    db.setReadBarrier(parallelAddressPath, 2);
    const parallelAddress = await Promise.allSettled([
      otp.sendOtp.run(
        {
          channel: 'email',
          identifier: 'parallel-address@example.com',
        },
        { auth: null, rawRequest: { ip: '203.0.113.61' } },
      ),
      otp.sendOtp.run(
        {
          channel: 'email',
          identifier: 'parallel-address@example.com',
        },
        { auth: null, rawRequest: { ip: '203.0.113.62' } },
      ),
    ]);
    check(
      'parallel sends cannot both pass the last address quota slot',
      parallelAddress.filter((result) => result.status === 'fulfilled').length,
      1,
    );
    check(
      'the losing parallel address send is rate limited',
      countOutcomes(parallelAddress, 'resource-exhausted'),
      1,
    );
    check(
      'the address quota never exceeds its limit',
      db.docs.get(parallelAddressPath)?.sendCount,
      5,
    );
  } finally {
    for (const [name, value] of Object.entries(previousProviders)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('failed checks:');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
