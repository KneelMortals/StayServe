import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attachVerifiedPhone,
  isPhoneProviderToken,
  phoneOfToken,
  prepareVerifiedPhoneIdentity,
  refreshIdentityToken,
  syncVerifiedPhoneProfile,
} from './live_test_identity.mjs';

const baseArguments = {
  projectId: 'demo-project',
  apiKey: 'api-key',
  uid: 'user-1',
  email: 'user@example.test',
  password: 'password',
  phoneNumber: '+15555550100',
  verificationCode: '123456',
};

function fakeIdToken(claims) {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(claims)}.`;
}

const phoneIdToken = fakeIdToken({
  sub: 'user-1',
  phone_number: '+15555550100',
  firebase: { sign_in_provider: 'phone' },
});

const passwordIdToken = fakeIdToken({
  sub: 'user-1',
  firebase: { sign_in_provider: 'password' },
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('the live identity helper recognises a phone-provider token', () => {
  assert.equal(isPhoneProviderToken(phoneIdToken), true);
  assert.equal(phoneOfToken(phoneIdToken), '+15555550100');

  // A password session is not a proof, even when it carries a number.
  assert.equal(isPhoneProviderToken(passwordIdToken), false);
  assert.equal(isPhoneProviderToken('not-a-token'), false);
});

test('the live identity helper links a genuinely verified phone', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).includes('/accounts:signInWithPassword')) {
      return jsonResponse({
        localId: 'user-1',
        idToken: 'password-session-token',
        refreshToken: 'password-refresh-token',
      });
    }
    if (String(url).includes('/accounts:sendVerificationCode')) {
      return jsonResponse({ sessionInfo: 'session-1' });
    }
    if (String(url).includes('/accounts:signInWithPhoneNumber')) {
      return jsonResponse({
        localId: 'user-1',
        idToken: phoneIdToken,
        refreshToken: 'phone-refresh-token',
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const identity = await attachVerifiedPhone(baseArguments);

  assert.equal(identity.uid, 'user-1');
  assert.equal(identity.idToken, phoneIdToken);
  assert.equal(identity.refreshToken, 'phone-refresh-token');
  assert.equal(identity.phoneNumber, '+15555550100');

  assert.equal(requests.length, 3);

  const signInRequest = requests[0];
  assert.match(signInRequest.url, /accounts:signInWithPassword\?key=api-key$/);
  const signInBody = JSON.parse(signInRequest.options.body);
  assert.equal(signInBody.email, 'user@example.test');
  assert.equal(signInBody.password, 'password');
  assert.equal(signInBody.returnSecureToken, true);

  const codeRequest = requests[1];
  assert.match(codeRequest.url, /accounts:sendVerificationCode\?key=api-key$/);
  const codeBody = JSON.parse(codeRequest.options.body);
  assert.equal(codeBody.phoneNumber, '+15555550100');

  const linkRequest = requests[2];
  assert.match(linkRequest.url, /accounts:signInWithPhoneNumber\?key=api-key$/);
  const linkBody = JSON.parse(linkRequest.options.body);
  assert.equal(linkBody.sessionInfo, 'session-1');
  assert.equal(linkBody.code, '123456');
  assert.equal(
    linkBody.idToken,
    'password-session-token',
    'the number is linked to the session of the account',
  );
});

test('the live identity helper reuses an earlier code request', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).includes('/accounts:signInWithPassword')) {
      return jsonResponse({ localId: 'user-1', idToken: 'password-session-token' });
    }
    if (String(url).includes('/accounts:signInWithPhoneNumber')) {
      return jsonResponse({
        localId: 'user-1',
        idToken: phoneIdToken,
        refreshToken: 'phone-refresh-token',
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const identity = await attachVerifiedPhone({
    ...baseArguments,
    verificationSessionInfo: 'session-from-earlier',
  });

  assert.equal(identity.idToken, phoneIdToken);
  assert.equal(requests.length, 2);
  const linkBody = JSON.parse(requests[1].options.body);
  assert.equal(linkBody.sessionInfo, 'session-from-earlier');
});

test('the live identity helper fails closed without an SMS code', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (url) => {
    if (String(url).includes('/accounts:signInWithPassword')) {
      return jsonResponse({ localId: 'user-1', idToken: 'password-session-token' });
    }
    if (String(url).includes('/accounts:sendVerificationCode')) {
      return jsonResponse({ sessionInfo: 'session-1' });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  await assert.rejects(
    attachVerifiedPhone({ ...baseArguments, verificationCode: '' }),
    /needs the SMS code of the test number/,
  );
});

test('the live identity helper rejects a session which is not phone-backed', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (url) => {
    if (String(url).includes('/accounts:signInWithPassword')) {
      return jsonResponse({ localId: 'user-1', idToken: 'password-session-token' });
    }
    if (String(url).includes('/accounts:sendVerificationCode')) {
      return jsonResponse({ sessionInfo: 'session-1' });
    }
    if (String(url).includes('/accounts:signInWithPhoneNumber')) {
      // A token which is not a phone-provider session is not a proof.
      return jsonResponse({ localId: 'user-1', idToken: passwordIdToken });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  await assert.rejects(
    attachVerifiedPhone(baseArguments),
    /not a phone-provider session/,
  );
});

test('the live identity helper refreshes the token of a signed-in account', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).includes('/accounts:signInWithPassword')) {
      return jsonResponse({
        localId: 'user-1',
        idToken: 'fresh-id-token',
        refreshToken: 'fresh-refresh-token',
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const identity = await refreshIdentityToken({
    apiKey: 'api-key',
    email: 'user@example.test',
    password: 'password',
  });

  assert.equal(identity.uid, 'user-1');
  assert.equal(identity.idToken, 'fresh-id-token');
  assert.equal(identity.refreshToken, 'fresh-refresh-token');
  assert.equal(requests.length, 1);
});

test('the live identity helper records the proof through the server', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).includes('/syncAuthProfile')) {
      return jsonResponse({
        result: { success: true, phoneVerified: true, phone: '+15555550100' },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const result = await syncVerifiedPhoneProfile({
    functionsBase: 'https://functions.example.test',
    idToken: 'phone-token',
    appCheckToken: 'app-check-token',
  });

  assert.equal(result.phoneVerified, true);
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    'https://functions.example.test/syncAuthProfile',
  );
  assert.equal(
    requests[0].options.headers.Authorization,
    'Bearer phone-token',
  );
  assert.equal(
    requests[0].options.headers['X-Firebase-AppCheck'],
    'app-check-token',
  );
});

test('the live identity helper fails closed when the server refuses the proof', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () =>
    jsonResponse({ result: { success: true, phoneVerified: false } });

  await assert.rejects(
    syncVerifiedPhoneProfile({
      functionsBase: 'https://functions.example.test',
      idToken: 'phone-token',
    }),
    /did not accept the phone number as verified/,
  );
});

test('the live identity helper prepares a complete verified identity', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).includes('/accounts:signInWithPassword')) {
      return jsonResponse({
        localId: 'user-1',
        idToken: 'password-session-token',
        refreshToken: 'password-refresh-token',
      });
    }
    if (String(url).includes('/accounts:sendVerificationCode')) {
      return jsonResponse({ sessionInfo: 'session-1' });
    }
    if (String(url).includes('/accounts:signInWithPhoneNumber')) {
      return jsonResponse({
        localId: 'user-1',
        idToken: phoneIdToken,
        refreshToken: 'phone-refresh-token',
      });
    }
    if (String(url).includes('/syncAuthProfile')) {
      return jsonResponse({
        result: { success: true, phoneVerified: true, phone: '+15555550100' },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  const identity = await prepareVerifiedPhoneIdentity({
    projectId: 'demo-project',
    apiKey: 'api-key',
    functionsBase: 'https://functions.example.test',
    uid: 'user-1',
    email: 'user@example.test',
    password: 'password',
    phoneNumber: '+15555550100',
    verificationCode: '123456',
  });

  // The returned token is the one of the fresh sign-in: it carries the
  // signed claims which the Firestore and Storage rules evaluate.
  assert.equal(identity.idToken, 'password-session-token');
  assert.equal(identity.uid, 'user-1');
  assert.equal(identity.phoneNumber, '+15555550100');

  const urls = requests.map((request) => request.url);
  assert.ok(urls.some((url) => url.includes('/accounts:signInWithPassword')));
  assert.ok(urls.some((url) => url.includes('/accounts:signInWithPhoneNumber')));
  assert.ok(urls.some((url) => url.includes('/syncAuthProfile')));
});
