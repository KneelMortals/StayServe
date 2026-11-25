// Focused integration regressions for live phone enforcement, delayed Auth
// bootstrap fencing, and durable registration-rollback retries.
//
//   node functions/test/security_hardening_test.mjs <firestore-port> <project>

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const require = createRequire(import.meta.url);

const PORT = process.argv[2] || '8181';
const PROJECT = process.argv[3] || 'demo-stayserve-security-hardening';

process.env.FIRESTORE_EMULATOR_HOST = `127.0.0.1:${PORT}`;
process.env.GCLOUD_PROJECT = PROJECT;
process.env.GCLOUD_PROJECT_ID = PROJECT;
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: PROJECT });
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';

const firestore = require('firebase-admin/firestore');
const authSdk = require('firebase-admin/auth');
const {
  assertActiveAccount,
  assertLiveOwner,
  assertLiveOwnerOrAdmin,
  assertLiveStudent,
} = require(path.join(ROOT, 'lib', 'accounts.js'));
const {
  ensureUserProfile,
} = require(path.join(ROOT, 'lib', 'profileBootstrap.js'));
const {
  processRegistrationRollbackOperations,
  rollbackIncompleteRegistration,
} = require(path.join(ROOT, 'lib', 'authProfile.js'));

const db = firestore.getFirestore();
const auth = authSdk.getAuth();

let pass = 0;
let fail = 0;
const failures = [];

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    failures.push(label);
    console.log(
      `  FAIL  ${label} expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`,
    );
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

async function expectDenied(label, action, expectedCode = 'permission-denied') {
  try {
    await action();
    check(label, 'allowed', `rejected (${expectedCode})`);
  } catch (error) {
    const code = String(error?.code || '');
    const message = String(error?.message || '');
    const ok = code.includes(expectedCode) || message.includes(expectedCode);
    check(
      label,
      ok ? `rejected (${code || expectedCode})` : `${code}: ${message}`,
      `rejected (${expectedCode})`,
    );
  }
}

function accountDeletionJobId(uid) {
  const digest = crypto.createHash('sha256').update(uid.trim()).digest('hex');
  return `account-deletion-${digest}`;
}

async function reset() {
  const collections = [
    'users',
    'registrationRollbackOperations',
    'accountDeletionJobs',
  ];
  for (const collection of collections) {
    const snapshot = await db.collection(collection).get();
    await Promise.all(snapshot.docs.map((document) => document.ref.delete()));
  }
}

async function seedStudent(uid, overrides = {}) {
  await db.collection('users').doc(uid).set({
    uid,
    name: uid,
    role: 'student',
    roleClaimed: true,
    registrationCompleted: true,
    isActive: true,
    email: `${uid}@example.test`,
    emailVerified: true,
    ...overrides,
  });
}

async function seedOwner(uid, overrides = {}) {
  await db.collection('users').doc(uid).set({
    uid,
    name: uid,
    role: 'owner',
    roleClaimed: true,
    registrationCompleted: true,
    isActive: true,
    email: `${uid}@example.test`,
    emailVerified: true,
    ...overrides,
  });
}

async function testLivePhoneIsAuthoritative() {
  section('live Firebase Auth is authoritative for the verified phone');

  await reset();
  await seedStudent('legacy-student');

  const originalGetUser = auth.getUser;
  auth.getUser = async (uid) => ({
    uid,
    email: `${uid}@example.test`,
    emailVerified: true,
    phoneNumber: '+919876500001',
    providerData: [{ providerId: 'password' }, { providerId: 'phone' }],
  });
  try {
    await assertLiveStudent('legacy-student');
    const backfilled = await db.collection('users').doc('legacy-student').get();
    check(
      'a legacy profile with a live phone is authorized',
      backfilled.get('phoneVerified'),
      true,
    );
    check(
      'the live phone is copied into the rules-facing cache',
      backfilled.get('phone'),
      '+919876500001',
    );

    auth.getUser = async (uid) => ({
      uid,
      email: `${uid}@example.test`,
      emailVerified: true,
      phoneNumber: null,
      providerData: [{ providerId: 'password' }],
    });
    await expectDenied(
      'a cached phone grant cannot survive an unlinked live provider',
      () => assertLiveStudent('legacy-student'),
    );
    const revoked = await db.collection('users').doc('legacy-student').get();
    check('the stale cached phone grant is revoked', revoked.get('phoneVerified'), false);

    auth.getUser = async () => {
      throw new Error('simulated Auth outage');
    };
    await expectDenied(
      'an Auth lookup failure fails closed',
      () => assertActiveAccount('legacy-student'),
    );
  } finally {
    auth.getUser = originalGetUser;
  }
}

async function testLiveOwnerAndAdminState() {
  section('live owner authorization also requires a complete active account');

  await reset();
  await seedOwner('live-owner');
  await seedOwner('inactive-owner', { isActive: false });
  await seedOwner('incomplete-owner', { registrationCompleted: false });
  await seedOwner('live-admin', { role: 'admin' });

  const originalGetUser = auth.getUser;
  auth.getUser = async (uid) => ({
    uid,
    email: `${uid}@example.test`,
    emailVerified: true,
    phoneNumber: '+919876500004',
    providerData: [{ providerId: 'password' }, { providerId: 'phone' }],
  });
  try {
    await assertLiveOwner('live-owner');
    check('a live owner with a verified phone is authorized', true, true);

    await expectDenied(
      'an inactive owner is refused even with a verified phone',
      () => assertLiveOwner('inactive-owner'),
    );
    await expectDenied(
      'an incomplete owner is refused even with a verified phone',
      () => assertLiveOwner('incomplete-owner'),
    );
    await expectDenied(
      'an administrator is not authorized through the owner-only helper',
      () => assertLiveOwner('live-admin'),
    );

    check(
      'the owner-or-admin helper returns the live owner role',
      await assertLiveOwnerOrAdmin('live-owner'),
      'owner',
    );
    check(
      'the owner-or-admin helper returns the live administrator role',
      await assertLiveOwnerOrAdmin('live-admin'),
      'admin',
    );
  } finally {
    auth.getUser = originalGetUser;
  }
}

async function testDelayedBootstrapCannotResurrectAnAccount() {
  section('a delayed Auth bootstrap cannot resurrect a rolled-back or deleted account');

  await reset();
  await db.collection('registrationRollbackOperations').doc('rolled-back-user').set({
    uid: 'rolled-back-user',
    status: 'rollbackRequested',
  });
  const rollbackResult = await ensureUserProfile({
    uid: 'rolled-back-user',
    displayName: 'Rolled Back',
    email: 'rolled-back@example.test',
    emailVerified: true,
    phoneNumber: '+919876500002',
    providerData: [{ providerId: 'password' }],
  });
  check('the bootstrap skips a durably rolled-back uid', rollbackResult, 'skipped');
  check(
    'the rolled-back uid has no resurrected profile',
    (await db.collection('users').doc('rolled-back-user').get()).exists,
    false,
  );

  await reset();
  await db
    .collection('accountDeletionJobs')
    .doc(accountDeletionJobId('deleted-user'))
    .set({
      type: 'accountDeletion',
      status: 'completed',
    });
  const deletedResult = await ensureUserProfile({
    uid: 'deleted-user',
    displayName: 'Deleted',
    email: 'deleted@example.test',
    emailVerified: true,
    phoneNumber: '+919876500003',
    providerData: [{ providerId: 'password' }],
  });
  check('the bootstrap skips a completed account-deletion uid', deletedResult, 'skipped');
  check(
    'the deleted uid has no resurrected profile',
    (await db.collection('users').doc('deleted-user').get()).exists,
    false,
  );
}

async function testRollbackReportsConcurrentRegistration() {
  section('a rollback reports a registration which committed concurrently');

  await reset();
  await db.collection('users').doc('race-registration').set({
    uid: 'race-registration',
    role: 'student',
    roleClaimed: false,
    registrationCompleted: false,
    isActive: true,
    createdAt: firestore.Timestamp.now(),
  });

  const originalRunTransaction = db.runTransaction.bind(db);
  const originalDeleteUser = auth.deleteUser;
  let transactionCalls = 0;
  let deleteCalls = 0;

  db.runTransaction = async (updateFunction) => {
    const result = await originalRunTransaction(updateFunction);
    transactionCalls += 1;
    if (transactionCalls === 1) {
      // Simulate the registration transaction committing after the rollback
      // marker was created but before the Auth deletion is attempted.
      await db.collection('users').doc('race-registration').set(
        {
          roleClaimed: true,
          registrationCompleted: true,
        },
        { merge: true },
      );
    }
    return result;
  };
  auth.deleteUser = async () => {
    deleteCalls += 1;
  };

  try {
    const result = await rollbackIncompleteRegistration.run(
      { uid: 'race-registration' },
      {
        auth: { uid: 'race-registration', token: {} },
        rawRequest: {},
        instanceIdToken: null,
      },
    );
    check(
      'the concurrent registration is reported as committed',
      result.registrationCompleted,
      true,
    );
    check('the committed account is not reported as rolled back', result.rolledBack, false);
    check('the committed Auth account was not deleted', deleteCalls, 0);
    check(
      'the durable marker preserves the committed registration',
      (
        await db
          .collection('registrationRollbackOperations')
          .doc('race-registration')
          .get()
      ).get('status'),
      'registrationCompleted',
    );
  } finally {
    db.runTransaction = originalRunTransaction;
    auth.deleteUser = originalDeleteUser;
  }
}

async function testRollbackWorkerRetriesTransientAuthFailure() {
  section('a transient Auth deletion failure is retried by the durable worker');

  await reset();
  await db.collection('users').doc('retry-user').set({
    uid: 'retry-user',
    role: 'student',
    roleClaimed: false,
    registrationCompleted: false,
    isActive: true,
    createdAt: firestore.Timestamp.now(),
  });

  const originalDeleteUser = auth.deleteUser;
  let deleteCalls = 0;
  auth.deleteUser = async () => {
    deleteCalls += 1;
    throw new Error('simulated transient Auth failure');
  };
  try {
    await expectDenied(
      'the callable reports a transient rollback failure',
      () =>
        rollbackIncompleteRegistration.run(
          { uid: 'retry-user' },
          {
            auth: { uid: 'retry-user', token: {} },
            rawRequest: {},
            instanceIdToken: null,
          },
        ),
      'internal',
    );
    const failedMarker = await db
      .collection('registrationRollbackOperations')
      .doc('retry-user')
      .get();
    check(
      'the failed Auth deletion leaves a durable retry marker',
      failedMarker.get('status'),
      'rollbackRequested',
    );

    // Make the marker due immediately, as it would be after the retry delay.
    await failedMarker.ref.set(
      { nextAttemptAt: firestore.Timestamp.fromMillis(Date.now() - 1000) },
      { merge: true },
    );
    auth.deleteUser = async (uid) => {
      deleteCalls += 1;
      if (uid !== 'retry-user') throw new Error('wrong uid');
    };
    const summary = await processRegistrationRollbackOperations();
    check('the worker deletes the retried Auth account', summary.deleted, 1);
    check('the worker reports no failed deletion', summary.failed, 0);
    check('the worker made one failed and one successful Auth call', deleteCalls, 2);
    const completedMarker = await db
      .collection('registrationRollbackOperations')
      .doc('retry-user')
      .get();
    check(
      'the completed retry is recorded durably',
      completedMarker.get('status'),
      'authDeleted',
    );
  } finally {
    auth.deleteUser = originalDeleteUser;
  }

  await reset();
  await db.collection('users').doc('committed-user').set({
    uid: 'committed-user',
    role: 'student',
    roleClaimed: true,
    registrationCompleted: true,
    isActive: true,
    createdAt: firestore.Timestamp.now(),
  });
  await db.collection('registrationRollbackOperations').doc('committed-user').set({
    uid: 'committed-user',
    status: 'rollbackRequested',
  });
  let committedDeleteCalls = 0;
  auth.deleteUser = async () => {
    committedDeleteCalls += 1;
  };
  try {
    const summary = await processRegistrationRollbackOperations();
    check('the worker preserves a committed registration', summary.completed, 1);
    check('the worker did not delete the committed Auth account', committedDeleteCalls, 0);
  } finally {
    auth.deleteUser = originalDeleteUser;
  }
}

async function main() {
  await testLivePhoneIsAuthoritative();
  await testLiveOwnerAndAdminState();
  await testDelayedBootstrapCannotResurrectAnAccount();
  await testRollbackReportsConcurrentRegistration();
  await testRollbackWorkerRetriesTransientAuthFailure();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error(`Failed regressions: ${failures.join(', ')}`);
    process.exitCode = 1;
  }
}

await main();
