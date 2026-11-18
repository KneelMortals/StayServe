// Isolated production smoke test for the owner/listing and student/booking
// paths. It creates two disposable accounts, one disposable listing and one
// disposable conversation, exercises the deployed client rules and callables,
// and removes every artifact it creates.
//
// This test intentionally uses the same channels as the Flutter app:
//   * a client ID token for Firestore and Storage writes;
//   * callable HTTPS requests for owner, booking, visit and messaging actions;
//   * the server-side OAuth channel only to prepare the disposable live roles
//     and to verify/clean the resulting data.
//
// Run from the repository root:
//
//   node tools/production_core_flow_smoke.mjs

import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const firebaseToolsAuth = require('firebase-tools/lib/auth');

const PROJECT_ID = 'myfirstapp-fa30f52b';
const BUCKET = `${PROJECT_ID}.firebasestorage.app`;
const API_KEY = 'AIzaSyDXm8VBnXgwKHajc-0GRwVHb5mk95agIUM';
const FIRESTORE_BASE =
  `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}` +
  '/databases/(default)/documents';
const STORAGE_ADMIN_BASE = `https://storage.googleapis.com/storage/v1/b/${BUCKET}/o`;
const STORAGE_CLIENT_BASE = `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o`;
const AUTH_BASE = 'https://identitytoolkit.googleapis.com/v1';
const FUNCTIONS_BASE = `https://us-central1-${PROJECT_ID}.cloudfunctions.net`;

const EXACT_LOCATION = {
  address: '42 Production Smoke Test Lane',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560001',
  latitude: 12.9716,
  longitude: 77.5946,
};

const UPDATED_EXACT_LOCATION = {
  ...EXACT_LOCATION,
  address: '43 Updated Production Smoke Test Lane',
};

let adminToken = '';
let passed = 0;
let failed = 0;

const artifacts = {
  accounts: [],
  roomId: '',
  objectPath: '',
  requestId: '',
  conversationId: '',
  messageId: '',
  lockId: '',
};

function check(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}${detail ? `  (${detail})` : ''}`);
    return;
  }
  failed++;
  console.error(`  FAIL  ${label}${detail ? `  (${detail})` : ''}`);
  throw new Error(label);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
  }
  return { status: response.status, body };
}

async function getAdminToken() {
  const account = firebaseToolsAuth.getGlobalDefaultAccount();
  if (!account?.tokens?.refresh_token) {
    throw new Error('No Firebase CLI refresh token. Run firebase login first.');
  }
  const token = await firebaseToolsAuth.getAccessToken(
    account.tokens.refresh_token,
    ['https://www.googleapis.com/auth/cloud-platform'],
  );
  if (!token?.access_token) {
    throw new Error('Could not refresh the Firebase CLI access token.');
  }
  return token.access_token;
}

function adminHeaders() {
  return {
    Authorization: `Bearer ${adminToken}`,
    'Content-Type': 'application/json',
  };
}

async function adminFirestore(method, path, body) {
  return jsonRequest(`${FIRESTORE_BASE}${path}`, {
    method,
    headers: adminHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function clientFirestore(token, method, path, body) {
  return jsonRequest(`${FIRESTORE_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function callable(name, token, data = {}) {
  return jsonRequest(`${FUNCTIONS_BASE}/${name}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ data }),
  });
}

function scalar(value) {
  if (!value) return undefined;
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('booleanValue' in value) return value.booleanValue;
  if ('timestampValue' in value) return value.timestampValue;
  if ('nullValue' in value) return null;
  return undefined;
}

function mapValue(value) {
  return value?.mapValue?.fields || {};
}

function stringArray(value) {
  return (value?.arrayValue?.values || [])
    .map((entry) => scalar(entry))
    .filter((entry) => typeof entry === 'string');
}

async function listCollection(collection) {
  const documents = [];
  let pageToken = '';
  do {
    const url = new URL(`${FIRESTORE_BASE}/${collection}`);
    url.searchParams.set('pageSize', '300');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const response = await jsonRequest(url.toString(), {
      headers: adminHeaders(),
    });
    if (response.status >= 400) {
      throw new Error(
        `Could not list ${collection}: HTTP ${response.status} ` +
          JSON.stringify(response.body),
      );
    }
    documents.push(...(response.body?.documents || []));
    pageToken = response.body?.nextPageToken || '';
  } while (pageToken);
  return documents;
}

async function createDisposableAccount(label) {
  const email = `stayserve-core-smoke-${label}-${Date.now()}-` +
    `${crypto.randomBytes(4).toString('hex')}@example.invalid`;
  const password = crypto.randomBytes(24).toString('base64url');
  const response = await jsonRequest(
    `${AUTH_BASE}/accounts:signUp?key=${encodeURIComponent(API_KEY)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password,
        returnSecureToken: true,
      }),
    },
  );
  if (response.status !== 200 || !response.body?.localId) {
    throw new Error(
      `Could not create the disposable ${label}: HTTP ${response.status} ` +
        JSON.stringify(response.body),
    );
  }
  const account = {
    label,
    email,
    password,
    uid: response.body.localId,
    token: response.body.idToken,
  };
  artifacts.accounts.push(account);
  return account;
}

async function makeLiveProfile(account, role) {
  const now = new Date().toISOString();
  const response = await adminFirestore('PATCH', `/users/${account.uid}`, {
    fields: {
      uid: { stringValue: account.uid },
      email: { stringValue: account.email },
      name: { stringValue: `Temporary ${role} smoke account` },
      phone: { nullValue: null },
      role: { stringValue: role },
      roleClaimed: { booleanValue: true },
      isActive: { booleanValue: true },
      registrationCompleted: { booleanValue: true },
      createdAt: { timestampValue: now },
      updatedAt: { timestampValue: now },
      savedRooms: { arrayValue: { values: [] } },
    },
  });
  if (response.status >= 400) {
    throw new Error(
      `Could not make the disposable ${role} live: HTTP ${response.status} ` +
        JSON.stringify(response.body),
    );
  }
}

async function uploadPhoto(account, roomId) {
  const objectPath = `rooms/${account.uid}/${roomId}/smoke.png`;
  artifacts.objectPath = objectPath;
  const url = new URL(STORAGE_CLIENT_BASE);
  url.searchParams.set('uploadType', 'media');
  url.searchParams.set('name', objectPath);
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  const response = await jsonRequest(url.toString(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${account.token}`,
      'Content-Type': 'image/png',
    },
    body: png,
  });
  if (response.status !== 200) {
    throw new Error(
      `Could not upload the disposable room photo: HTTP ${response.status} ` +
        JSON.stringify(response.body),
    );
  }
  const uploaded = response.body;
  const downloadToken = uploaded.downloadTokens || '';
  const imageUrl =
    `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(BUCKET)}` +
    `/o/${encodeURIComponent(objectPath)}?alt=media` +
    (downloadToken ? `&token=${encodeURIComponent(downloadToken)}` : '');
  return { uploaded, imageUrl };
}

async function createRoom(account, imageUrl) {
  const roomId = artifacts.roomId || `RM-SMOKE-${crypto.randomUUID()}`;
  artifacts.roomId = roomId;
  const now = new Date().toISOString();
  const response = await clientFirestore(
    account.token,
    'PATCH',
    `/rooms/${roomId}`,
    {
      fields: {
        roomId: { stringValue: roomId },
        ownerId: { stringValue: account.uid },
        title: { stringValue: 'Temporary production smoke listing' },
        description: {
          stringValue: 'Disposable listing used by the production smoke test.',
        },
        monthlyRent: { doubleValue: 7000 },
        securityDeposit: { doubleValue: 10000 },
        location: {
          mapValue: {
            fields: {
              city: { stringValue: EXACT_LOCATION.city },
              state: { stringValue: EXACT_LOCATION.state },
            },
          },
        },
        roomType: { stringValue: 'single' },
        furnishing: { stringValue: 'unfurnished' },
        availableFrom: { timestampValue: now },
        amenities: { arrayValue: { values: [] } },
        occupancy: { integerValue: '2' },
        currentOccupancy: { integerValue: '0' },
        genderPreference: { stringValue: 'any' },
        images: {
          arrayValue: { values: [{ stringValue: imageUrl }] },
        },
        status: { stringValue: 'available' },
        createdAt: { timestampValue: now },
        updatedAt: { timestampValue: now },
      },
    },
  );
  if (response.status !== 200) {
    throw new Error(
      `Could not create the disposable room: HTTP ${response.status} ` +
        JSON.stringify(response.body),
    );
  }
  return roomId;
}

async function updateRoomTitle(account, roomId, title) {
  const updateMask = new URLSearchParams();
  updateMask.append('updateMask.fieldPaths', 'title');
  return clientFirestore(
    account.token,
    'PATCH',
    `/rooms/${roomId}?${updateMask.toString()}`,
    {
      fields: {
        title: { stringValue: title },
      },
    },
  );
}

async function setPrivateLocation(owner, roomId, location = EXACT_LOCATION) {
  const response = await callable('setRoomPrivateLocation', owner.token, {
    roomId,
    ...location,
  });
  if (response.status !== 200 || response.body?.error) {
    throw new Error(
      'Could not set the disposable private location: ' +
        `HTTP ${response.status} ${JSON.stringify(response.body)}`,
    );
  }
  return response.body?.result || {};
}

async function expectCallableDenied(name, token, data) {
  const response = await callable(name, token, data);
  check(
    `${name} denies the unauthorized caller`,
    response.status >= 400 && Boolean(response.body?.error),
    `HTTP ${response.status} ${response.body?.error?.status || ''}`,
  );
}

async function createMessage(student, owner, roomId, conversationId) {
  const messageId = `MSG-SMOKE-${crypto.randomUUID()}`;
  artifacts.messageId = messageId;
  const now = new Date().toISOString();
  const messageResponse = await clientFirestore(
    student.token,
    'PATCH',
    `/conversations/${conversationId}/messages/${messageId}`,
    {
      fields: {
        messageId: { stringValue: messageId },
        conversationId: { stringValue: conversationId },
        senderId: { stringValue: student.uid },
        receiverId: { stringValue: owner.uid },
        content: { stringValue: 'Temporary production smoke message' },
        type: { stringValue: 'text' },
        createdAt: { timestampValue: now },
        roomId: { stringValue: roomId },
      },
    },
  );
  if (messageResponse.status !== 200) {
    throw new Error(
      `Could not create the disposable message: HTTP ${messageResponse.status} ` +
        JSON.stringify(messageResponse.body),
    );
  }

  const updateMask = new URLSearchParams();
  for (const field of [
    'lastMessage',
    'lastMessageAt',
    'updatedAt',
    'unreadCount',
    'roomId',
  ]) {
    updateMask.append('updateMask.fieldPaths', field);
  }
  const conversationResponse = await clientFirestore(
    student.token,
    'PATCH',
    `/conversations/${conversationId}?${updateMask.toString()}`,
    {
      fields: {
        lastMessage: { stringValue: 'Temporary production smoke message' },
        lastMessageAt: { timestampValue: now },
        updatedAt: { timestampValue: now },
        unreadCount: {
          mapValue: {
            fields: {
              [owner.uid]: { integerValue: '1' },
            },
          },
        },
        roomId: { stringValue: roomId },
      },
    },
  );
  if (conversationResponse.status !== 200) {
    throw new Error(
      'Could not update the disposable conversation: ' +
        `HTTP ${conversationResponse.status} ` +
        JSON.stringify(conversationResponse.body),
    );
  }
  return messageId;
}

function accountDeletionJobId(uid) {
  const digest = crypto
    .createHash('sha256')
    .update(uid.trim())
    .digest('hex');
  return `account-deletion-${digest}`;
}

async function deleteAuthAccount(account) {
  return jsonRequest(
    `${AUTH_BASE}/accounts:delete?key=${encodeURIComponent(API_KEY)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: account.token }),
    },
  );
}

async function authAccountExists(uid) {
  const response = await jsonRequest(
    `${AUTH_BASE}/accounts:lookup?key=${encodeURIComponent(API_KEY)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ localId: [uid] }),
    },
  );
  return (response.body?.users || []).some((user) => user.localId === uid);
}

async function storageObjects(prefix) {
  const url = new URL(STORAGE_ADMIN_BASE);
  url.searchParams.set('prefix', prefix);
  url.searchParams.set('maxResults', '1000');
  const response = await jsonRequest(url.toString(), {
    headers: adminHeaders(),
  });
  if (response.status >= 400) {
    throw new Error(
      `Could not list Storage objects: HTTP ${response.status} ` +
        JSON.stringify(response.body),
    );
  }
  return response.body?.items || [];
}

async function collectResidue() {
  const residue = [];
  const accountIds = new Set(artifacts.accounts.map((account) => account.uid));
  const knownDocuments = [];
  for (const account of artifacts.accounts) {
    knownDocuments.push([`users/${account.uid}`, `/users/${account.uid}`]);
    const jobId = accountDeletionJobId(account.uid);
    knownDocuments.push([
      `accountDeletionJobs/${jobId}`,
      `/accountDeletionJobs/${jobId}`,
    ]);
  }
  if (artifacts.roomId) {
    knownDocuments.push([`rooms/${artifacts.roomId}`, `/rooms/${artifacts.roomId}`]);
    knownDocuments.push([
      `roomPrivate/${artifacts.roomId}`,
      `/roomPrivate/${artifacts.roomId}`,
    ]);
    knownDocuments.push([
      `roomDeletionTombstones/${artifacts.roomId}`,
      `/roomDeletionTombstones/${artifacts.roomId}`,
    ]);
  }
  if (artifacts.requestId) {
    knownDocuments.push([
      `joinRequests/${artifacts.requestId}`,
      `/joinRequests/${artifacts.requestId}`,
    ]);
  }
  if (artifacts.lockId) {
    knownDocuments.push([
      `joinRequestLocks/${artifacts.lockId}`,
      `/joinRequestLocks/${artifacts.lockId}`,
    ]);
  }
  if (artifacts.conversationId) {
    knownDocuments.push([
      `conversations/${artifacts.conversationId}`,
      `/conversations/${artifacts.conversationId}`,
    ]);
  }
  for (const [label, path] of knownDocuments) {
    const response = await adminFirestore('GET', path);
    if (response.status !== 404) residue.push(`${label} (HTTP ${response.status})`);
  }

  if (artifacts.conversationId) {
    try {
      const messages = await listCollection(
        `conversations/${artifacts.conversationId}/messages`,
      );
      if (messages.length > 0) residue.push(`conversation messages (${messages.length})`);
    } catch (error) {
      if (!String(error?.message || '').includes('HTTP 404')) throw error;
    }
  }

  for (const account of artifacts.accounts) {
    if (await authAccountExists(account.uid)) {
      residue.push(`auth account ${account.uid}`);
    }
  }

  for (const account of artifacts.accounts) {
    const objects = await storageObjects(`rooms/${account.uid}/`);
    if (objects.length > 0) {
      residue.push(`Storage objects for ${account.uid} (${objects.length})`);
    }
  }

  const notifications = await listCollection('notifications');
  for (const document of notifications) {
    if (accountIds.has(scalar(document.fields?.userId))) {
      residue.push(`notification ${document.name.split('/').pop()}`);
    }
  }

  for (const collection of [
    'joinRequests',
    'joinRequestLocks',
    'cleanupJobs',
    'accountDeletionJobs',
    'roleClaimJobs',
    'conversations',
  ]) {
    const documents = await listCollection(collection);
    for (const document of documents) {
      const fields = document.fields || {};
      const participants = stringArray(fields.participantIds);
      const matches =
        accountIds.has(scalar(fields.studentId)) ||
        accountIds.has(scalar(fields.ownerId)) ||
        accountIds.has(scalar(fields.userId)) ||
        accountIds.has(scalar(fields.uid)) ||
        accountIds.has(scalar(fields.targetUid)) ||
        accountIds.has(scalar(fields.requestedBy)) ||
        participants.some((participant) => accountIds.has(participant)) ||
        (artifacts.roomId && scalar(fields.roomId) === artifacts.roomId) ||
        (artifacts.requestId && scalar(fields.requestId) === artifacts.requestId);
      if (matches) {
        residue.push(`${collection}/${document.name.split('/').pop()}`);
      }
    }
  }
  return residue;
}

async function waitFor(label, predicate, timeoutMilliseconds = 180000) {
  const startedAt = Date.now();
  let lastDetail = '';
  while (Date.now() - startedAt < timeoutMilliseconds) {
    const result = await predicate();
    if (result.ok) return result.detail || '';
    lastDetail = result.detail || '';
    await sleep(2000);
  }
  throw new Error(`${label} did not finish in time${lastDetail ? `: ${lastDetail}` : ''}`);
}

async function removeCompletedAccountDeletionTombstone(
  uid,
  timeoutMilliseconds = 180000,
) {
  const jobId = accountDeletionJobId(uid);
  await waitFor(
    'the completed account-deletion job',
    async () => {
      const response = await adminFirestore(
        'GET',
        `/accountDeletionJobs/${jobId}`,
      );
      const status = scalar(response.body?.fields?.status);
      return {
        ok: response.status === 200 && status === 'completed',
        detail: `HTTP ${response.status} status=${status || ''}`,
      };
    },
    timeoutMilliseconds,
  );
  const deleted = await adminFirestore(
    'DELETE',
    `/accountDeletionJobs/${jobId}`,
  );
  if (deleted.status >= 400 && deleted.status !== 404) {
    throw new Error(
      `Could not remove the completed account-deletion job ${jobId}: ` +
        `HTTP ${deleted.status}`,
    );
  }
}

async function cleanupProductionArtifacts() {
  console.log('\n--- cleanup ---');
  for (const account of artifacts.accounts) {
    try {
      const response = await deleteAuthAccount(account);
      console.log(
        `  auth account ${account.label} deleted -> HTTP ${response.status}`,
      );
    } catch (error) {
      console.error(`  auth cleanup failed for ${account.label}:`, error);
    }
  }

  const knownPaths = [];
  for (const account of artifacts.accounts) {
    knownPaths.push(`/users/${account.uid}`);
    knownPaths.push(`/accountDeletionJobs/${accountDeletionJobId(account.uid)}`);
  }
  if (artifacts.roomId) {
    knownPaths.push(`/rooms/${artifacts.roomId}`);
    knownPaths.push(`/roomPrivate/${artifacts.roomId}`);
    knownPaths.push(`/roomDeletionTombstones/${artifacts.roomId}`);
  }
  if (artifacts.requestId) {
    knownPaths.push(`/joinRequests/${artifacts.requestId}`);
  }
  if (artifacts.lockId) {
    knownPaths.push(`/joinRequestLocks/${artifacts.lockId}`);
  }
  if (artifacts.conversationId) {
    knownPaths.push(`/conversations/${artifacts.conversationId}`);
    if (artifacts.messageId) {
      knownPaths.push(
        `/conversations/${artifacts.conversationId}/messages/${artifacts.messageId}`,
      );
    }
  }
  for (const path of knownPaths) {
    try {
      const response = await adminFirestore('DELETE', path);
      console.log(`  Firestore ${path} deleted -> HTTP ${response.status}`);
    } catch (error) {
      console.error(`  Firestore cleanup failed for ${path}:`, error);
    }
  }

  const accountIds = new Set(artifacts.accounts.map((account) => account.uid));
  try {
    const notifications = await listCollection('notifications');
    for (const document of notifications) {
      const userId = scalar(document.fields?.userId);
      if (!accountIds.has(userId)) continue;
      await adminFirestore(
        'DELETE',
        `/notifications/${document.name.split('/').pop()}`,
      );
    }
  } catch (error) {
    console.error('  notification cleanup failed:', error);
  }

  for (const collection of [
    'joinRequests',
    'joinRequestLocks',
    'cleanupJobs',
    'accountDeletionJobs',
    'roleClaimJobs',
    'conversations',
  ]) {
    try {
      const documents = await listCollection(collection);
      for (const document of documents) {
        const fields = document.fields || {};
        const matches =
          accountIds.has(scalar(fields.studentId)) ||
          accountIds.has(scalar(fields.ownerId)) ||
          accountIds.has(scalar(fields.userId)) ||
          accountIds.has(scalar(fields.uid)) ||
          accountIds.has(scalar(fields.targetUid)) ||
          (artifacts.roomId && scalar(fields.roomId) === artifacts.roomId) ||
          (artifacts.requestId && scalar(fields.requestId) === artifacts.requestId);
        if (!matches) continue;
        await adminFirestore(
          'DELETE',
          `/${collection}/${document.name.split('/').pop()}`,
        );
      }
    } catch (error) {
      console.error(`  ${collection} cleanup failed:`, error);
    }
  }

  const prefixes = new Set();
  if (artifacts.objectPath) {
    prefixes.add(artifacts.objectPath);
  }
  for (const account of artifacts.accounts) {
    prefixes.add(`rooms/${account.uid}/`);
  }
  for (const prefix of prefixes) {
    try {
      const objects = await storageObjects(prefix);
      for (const object of objects) {
        await jsonRequest(
          `${STORAGE_ADMIN_BASE}/${encodeURIComponent(object.name)}`,
          { method: 'DELETE', headers: adminHeaders() },
        );
      }
      console.log(`  Storage prefix ${prefix} cleaned (${objects.length} object(s))`);
    } catch (error) {
      console.error(`  Storage cleanup failed for ${prefix}:`, error);
    }
  }
}

async function main() {
  console.log(`--- project ${PROJECT_ID} ---`);
  adminToken = await getAdminToken();

  const owner = await createDisposableAccount('owner');
  const student = await createDisposableAccount('student');
  console.log(`  owner uid: ${owner.uid}`);
  console.log(`  student uid: ${student.uid}`);

  await makeLiveProfile(owner, 'owner');
  await makeLiveProfile(student, 'student');
  check('the disposable owner and student are live', true);

  artifacts.roomId = `RM-SMOKE-${crypto.randomUUID()}`;
  const { uploaded, imageUrl } = await uploadPhoto(owner, artifacts.roomId);
  check(
    'the live owner uploaded a room photo',
    uploaded.name === artifacts.objectPath && uploaded.contentType === 'image/png',
    uploaded.name || '',
  );

  const roomId = await createRoom(owner, imageUrl);
  artifacts.lockId = crypto
    .createHash('sha256')
    .update(`${student.uid}:${roomId}`)
    .digest('hex');
  check('the live owner created a public room listing', Boolean(roomId), roomId);

  const privateLocation = await setPrivateLocation(owner, roomId);
  check(
    'the owner stored the exact location privately',
    privateLocation.success === true && privateLocation.stage === 'private',
    privateLocation.stage || '',
  );

  const roomResponse = await adminFirestore('GET', `/rooms/${roomId}`);
  const roomFields = roomResponse.body?.fields || {};
  const publicLocation = mapValue(roomFields.location);
  const publicExactKeys = [
    ...Object.keys(publicLocation),
    ...Object.keys(roomFields),
  ].filter((key) =>
    ['address', 'pincode', 'latitude', 'longitude'].includes(key),
  );
  check(
    'the public listing has no exact address or coordinates',
    publicExactKeys.length === 0,
    publicExactKeys.join(','),
  );
  check(
    'the public listing retains city, state and a coarse geo cell',
    scalar(publicLocation.city) === EXACT_LOCATION.city &&
      scalar(publicLocation.state) === EXACT_LOCATION.state &&
      typeof scalar(roomFields.geoCell) === 'string',
    String(scalar(roomFields.geoCell) || ''),
  );

  const privateResponse = await adminFirestore('GET', `/roomPrivate/${roomId}`);
  const privateFields = privateResponse.body?.fields || {};
  check(
    'the private listing retains the exact address and coordinates',
    scalar(privateFields.address) === EXACT_LOCATION.address &&
      scalar(privateFields.pincode) === EXACT_LOCATION.pincode &&
      Number(scalar(privateFields.latitude)) === EXACT_LOCATION.latitude &&
      Number(scalar(privateFields.longitude)) === EXACT_LOCATION.longitude,
    String(scalar(privateFields.address) || ''),
  );

  const titleUpdate = await updateRoomTitle(
    owner,
    roomId,
    'Updated temporary production smoke listing',
  );
  check(
    'the live owner edited the public listing',
    titleUpdate.status === 200,
    `HTTP ${titleUpdate.status}`,
  );
  const updatedPrivateLocation = await setPrivateLocation(
    owner,
    roomId,
    UPDATED_EXACT_LOCATION,
  );
  check(
    'the live owner edited the exact private location',
    updatedPrivateLocation.success === true &&
      updatedPrivateLocation.stage === 'private',
    updatedPrivateLocation.stage || '',
  );
  const updatedPrivateResponse = await adminFirestore(
    'GET',
    `/roomPrivate/${roomId}`,
  );
  check(
    'the private listing contains the owner edit',
    scalar(updatedPrivateResponse.body?.fields?.address) ===
      UPDATED_EXACT_LOCATION.address,
    String(scalar(updatedPrivateResponse.body?.fields?.address) || ''),
  );
  const editedRoomResponse = await adminFirestore('GET', `/rooms/${roomId}`);
  const editedRoomFields = editedRoomResponse.body?.fields || {};
  const editedPublicLocation = mapValue(editedRoomFields.location);
  const editedExactKeys = [
    ...Object.keys(editedPublicLocation),
    ...Object.keys(editedRoomFields),
  ].filter((key) =>
    ['address', 'pincode', 'latitude', 'longitude'].includes(key),
  );
  check(
    'the owner edit does not expose an exact public location',
    editedExactKeys.length === 0,
    editedExactKeys.join(','),
  );

  const studentPrivateRead = await clientFirestore(
    student.token,
    'GET',
    `/roomPrivate/${roomId}`,
  );
  check(
    'the student cannot read the private location directly',
    studentPrivateRead.status >= 400,
    `HTTP ${studentPrivateRead.status}`,
  );

  await expectCallableDenied('createJoinRequest', owner.token, { roomId });

  const requestResponse = await callable('createJoinRequest', student.token, {
    roomId,
  });
  const requestId = requestResponse.body?.result?.requestId;
  artifacts.requestId = requestId || '';
  check(
    'the live student created a booking request',
    requestResponse.status === 200 && Boolean(requestId),
    requestId || JSON.stringify(requestResponse.body),
  );

  const ownerResponse = await callable('respondToJoinRequest', owner.token, {
    requestId,
    approve: true,
  });
  check(
    'the live owner accepted the booking request',
    ownerResponse.status === 200 &&
      ownerResponse.body?.result?.status === 'ownerConfirmed',
    ownerResponse.body?.result?.status || '',
  );

  const studentResponse = await callable('confirmJoinAsStudent', student.token, {
    requestId,
  });
  check(
    'the live student confirmed the accepted booking',
    studentResponse.status === 200 &&
      studentResponse.body?.result?.status === 'studentConfirmed',
    studentResponse.body?.result?.status || '',
  );

  const visitResponse = await callable('getRoomVisitDetails', student.token, {
    roomId,
  });
  const visit = visitResponse.body?.result || {};
  check(
    'the accepted student received the exact visit address',
    visitResponse.status === 200 &&
      visit.address === UPDATED_EXACT_LOCATION.address &&
      visit.pincode === UPDATED_EXACT_LOCATION.pincode &&
      Number(visit.latitude) === EXACT_LOCATION.latitude &&
      Number(visit.longitude) === EXACT_LOCATION.longitude,
    String(visit.address || ''),
  );

  await expectCallableDenied('openConversation', owner.token, {
    otherUserId: student.uid,
    roomId,
  });

  const conversationResponse = await callable('openConversation', student.token, {
    otherUserId: owner.uid,
    roomId,
  });
  const conversationId = conversationResponse.body?.result?.conversationId;
  artifacts.conversationId = conversationId || '';
  check(
    'the live student opened a server-verified conversation',
    conversationResponse.status === 200 && Boolean(conversationId),
    conversationId || JSON.stringify(conversationResponse.body),
  );

  const messageId = await createMessage(
    student,
    owner,
    roomId,
    conversationId,
  );
  const ownerMessageRead = await clientFirestore(
    owner.token,
    'GET',
    `/conversations/${conversationId}/messages/${messageId}`,
  );
  check(
    'the owner participant can read the student message',
    ownerMessageRead.status === 200,
    `HTTP ${ownerMessageRead.status}`,
  );

  const notificationResponse = await callable('notifyUser', student.token, {
    userId: owner.uid,
    type: 'newMessage',
    data: { conversationId, messageId },
  });
  check(
    'the server created the message notification',
    notificationResponse.status === 200,
    `HTTP ${notificationResponse.status}`,
  );

  const deleteRoomResponse = await callable('deleteRoomListing', owner.token, {
    roomId,
  });
  check(
    'the live owner deleted the disposable listing',
    deleteRoomResponse.status === 200 &&
      deleteRoomResponse.body?.result?.success === true,
    JSON.stringify(deleteRoomResponse.body?.result || {}),
  );

  await waitFor('the listing cleanup', async () => {
    const [room, privateRoom, request, tombstone] = await Promise.all([
      adminFirestore('GET', `/rooms/${roomId}`),
      adminFirestore('GET', `/roomPrivate/${roomId}`),
      adminFirestore('GET', `/joinRequests/${requestId}`),
      adminFirestore('GET', `/roomDeletionTombstones/${roomId}`),
    ]);
    const objects = await storageObjects(`rooms/${owner.uid}/${roomId}/`);
    const requestStatus = scalar(request.body?.fields?.status);
    const clean =
      room.status === 404 &&
      privateRoom.status === 404 &&
      request.status === 200 &&
      requestStatus === 'cancelled' &&
      tombstone.status === 404 &&
      objects.length === 0;
    return {
      ok: clean,
      detail:
        `room=${room.status} private=${privateRoom.status} ` +
        `request=${request.status}:${requestStatus || ''} ` +
        `tombstone=${tombstone.status} objects=${objects.length}`,
    };
  });

  const studentDelete = await deleteAuthAccount(student);
  check(
    'the student deleted their disposable Auth account',
    studentDelete.status === 200,
    `HTTP ${studentDelete.status}`,
  );
  await waitFor('the student account cleanup', async () => {
    const profile = await adminFirestore('GET', `/users/${student.uid}`);
    const conversation = await adminFirestore(
      'GET',
      `/conversations/${conversationId}`,
    );
    const authExists = await authAccountExists(student.uid);
    return {
      ok:
        profile.status === 404 &&
        conversation.status === 404 &&
        !authExists,
      detail:
        `profile=${profile.status} conversation=${conversation.status} ` +
        `authExists=${authExists}`,
    };
  });
  await removeCompletedAccountDeletionTombstone(student.uid);

  const ownerDelete = await deleteAuthAccount(owner);
  check(
    'the owner deleted their disposable Auth account',
    ownerDelete.status === 200,
    `HTTP ${ownerDelete.status}`,
  );
  await waitFor('the owner account cleanup', async () => {
    const profile = await adminFirestore('GET', `/users/${owner.uid}`);
    const authExists = await authAccountExists(owner.uid);
    const objects = await storageObjects(`rooms/${owner.uid}/`);
    return {
      ok: profile.status === 404 && !authExists && objects.length === 0,
      detail:
        `profile=${profile.status} authExists=${authExists} ` +
        `objects=${objects.length}`,
    };
  });
  await removeCompletedAccountDeletionTombstone(owner.uid);

  const residue = await waitFor('the disposable-data residue check', async () => {
    const remaining = await collectResidue();
    return {
      ok: remaining.length === 0,
      detail: remaining.join(', '),
    };
  });
  check('no disposable production data remains', residue === '', residue);

  console.log(`\n${passed} passed, ${failed} failed`);
  console.log('Production core-flow smoke test passed; no disposable data remains.');
}

main()
  .catch(async (error) => {
    failed++;
    console.error('\nProduction core-flow smoke test failed:', error);
    await cleanupProductionArtifacts();
    console.error(`\n${passed} passed, ${failed} failed`);
    process.exitCode = 1;
  });
