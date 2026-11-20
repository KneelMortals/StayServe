#!/usr/bin/env node

// Configures or verifies the CORS policy on the production Firebase Storage
// bucket. The browser client needs this policy to decode room photos; mobile
// clients do not. `firebase deploy --only storage` deploys Storage rules but
// does not change bucket-level CORS metadata.
//
// Check only (default):
//   node tools/configure_storage_cors.mjs
//
// Apply the checked-in policy:
//   node tools/configure_storage_cors.mjs --apply

import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const firebaseToolsAuth = require('firebase-tools/lib/auth');

const PROJECT_ID =
  process.env.FIREBASE_PROJECT_ID ||
  process.env.GCLOUD_PROJECT ||
  'myfirstapp-fa30f52b';
const BUCKET =
  process.env.FIREBASE_STORAGE_BUCKET || `${PROJECT_ID}.firebasestorage.app`;
const CORS_FILE = path.resolve('storage.cors.json');
const APPLY = process.argv.includes('--apply');
const STORAGE_API = 'https://storage.googleapis.com/storage/v1';
const FIRESTORE_API = 'https://firestore.googleapis.com/v1';

function fail(message) {
  throw new Error(message);
}

async function accessToken() {
  const account = firebaseToolsAuth.getGlobalDefaultAccount();
  if (!account?.tokens?.refresh_token) {
    fail('No Firebase CLI refresh token. Run firebase login first.');
  }

  const token = await firebaseToolsAuth.getAccessToken(
    account.tokens.refresh_token,
    ['https://www.googleapis.com/auth/cloud-platform'],
  );
  if (!token?.access_token) {
    fail('Could not refresh the Firebase CLI access token.');
  }
  return token.access_token;
}

async function storageRequest(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
  }

  if (!response.ok) {
    fail(
      `Google Cloud Storage returned HTTP ${response.status}: ` +
        JSON.stringify(body),
    );
  }
  return body;
}

function validatePolicy(policy) {
  if (!Array.isArray(policy) || policy.length === 0) {
    fail('storage.cors.json must contain at least one CORS rule.');
  }

  for (const rule of policy) {
    if (!Array.isArray(rule.origin) || rule.origin.length === 0) {
      fail('Every CORS rule must contain at least one origin.');
    }
    if (!Array.isArray(rule.method) || !rule.method.includes('GET')) {
      fail('Every CORS rule must allow GET.');
    }
    if (rule.origin.includes('*')) {
      fail('Refusing an unrestricted wildcard origin in storage.cors.json.');
    }
  }
}

function canonical(value) {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, canonical(value[key])]),
    );
  }
  return value;
}

function policiesMatch(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

async function firstLiveRoomImage(token) {
  const url =
    `${FIRESTORE_API}/projects/${encodeURIComponent(PROJECT_ID)}` +
    '/databases/(default)/documents/rooms?pageSize=100';
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    fail(`Could not list live rooms: HTTP ${response.status}`);
  }

  const body = await response.json();
  for (const document of body.documents || []) {
    const images = document.fields?.images?.arrayValue?.values || [];
    const imageUrl = images.find(value => typeof value.stringValue === 'string')
      ?.stringValue;
    if (imageUrl) return imageUrl;
  }
  fail('No live room image URL was found for the CORS response check.');
}

async function verifyLiveImageResponse(policy) {
  const token = await accessToken();
  const imageUrl = await firstLiveRoomImage(token);
  const origin = policy
    .flatMap(rule => rule.origin)
    .find(value => value.startsWith('https://'));
  if (!origin) {
    fail('The CORS policy must contain the published HTTPS web origin.');
  }

  const response = await fetch(imageUrl, {
    headers: {
      Origin: origin,
      Range: 'bytes=0-0',
    },
  });
  await response.arrayBuffer();
  if (!response.ok) {
    fail(`The live room image returned HTTP ${response.status}.`);
  }

  const allowedOrigin = response.headers.get('access-control-allow-origin');
  if (allowedOrigin !== origin) {
    fail(
      `The live room image did not allow ${origin} ` +
        `(Access-Control-Allow-Origin: ${allowedOrigin || 'missing'}).`,
    );
  }
  console.log(`PASS  A live room image allows browser origin ${origin}`);
}

async function main() {
  const policy = JSON.parse(await fs.readFile(CORS_FILE, 'utf8'));
  validatePolicy(policy);

  const token = await accessToken();
  const bucketUrl = `${STORAGE_API}/b/${encodeURIComponent(BUCKET)}`;
  const metadata = await storageRequest(bucketUrl, token);
  const current = metadata.cors || [];

  if (policiesMatch(current, policy)) {
    console.log(`PASS  Storage CORS already matches ${CORS_FILE}`);
  } else {
    if (!APPLY) {
      console.error(`FAIL  Storage CORS does not match ${CORS_FILE}`);
      console.error(`      Bucket: ${BUCKET}`);
      console.error('      Run with --apply after approving the production change.');
      process.exitCode = 1;
      return;
    }

    const metageneration = Number(metadata.metageneration);
    if (!Number.isSafeInteger(metageneration) || metageneration < 1) {
      fail('The bucket response did not include a metageneration precondition.');
    }

    const updateUrl =
      `${bucketUrl}?ifMetagenerationMatch=${encodeURIComponent(metageneration)}`;
    const updated = await storageRequest(updateUrl, token, {
      method: 'PATCH',
      body: JSON.stringify({ cors: policy }),
    });

    if (!policiesMatch(updated.cors || [], policy)) {
      fail(
        'Google Cloud Storage accepted the update but returned different CORS.',
      );
    }
    console.log(`PASS  Applied Storage CORS to ${BUCKET}`);
  }

  console.log(`      Origins: ${policy.flatMap(rule => rule.origin).join(', ')}`);
  console.log(
    `      Methods: ${[...new Set(policy.flatMap(rule => rule.method))].join(', ')}`,
  );
  await verifyLiveImageResponse(policy);
}

main().catch(error => {
  console.error(`ERROR  ${error.message || error}`);
  process.exitCode = 1;
});
