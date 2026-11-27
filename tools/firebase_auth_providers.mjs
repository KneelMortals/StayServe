// Reads or updates the Firebase Auth provider configuration of a project.
//
// The Firebase CLI keeps a refresh token with the `firebase` and
// `cloud-platform` scopes. That token is exchanged for an access token and
// used with the Identity Toolkit Admin API, which is the API the Firebase
// Console itself uses when you switch a sign-in provider on.
//
// Usage:
//   node tools/firebase_auth_providers.mjs status
//   node tools/firebase_auth_providers.mjs enable-phone
//   node tools/firebase_auth_providers.mjs enable-email-password
//   node tools/firebase_auth_providers.mjs enable-google <webClientId>

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'myfirstapp-fa30f52b';
const CONFIGSTORE = join(homedir(), '.config', 'configstore', 'firebase-tools.json');
// The CLI token is restricted to the scopes it was granted. `cloud-platform`
// is one of them and it covers the Identity Toolkit Admin API.
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/**
 * The OAuth client of the Firebase CLI.
 *
 * The credentials are **not** written down in this repository. They are read
 * from the installed `firebase-tools` package, which ships them as the public
 * "installed application" client of the CLI. `FIREBASE_CLIENT_ID` and
 * `FIREBASE_CLIENT_SECRET` override them.
 */
function cliCredentials() {
  try {
    const api = require('firebase-tools/lib/api.js');
    return {
      clientId: api.clientId(),
      clientSecret: api.clientSecret(),
    };
  } catch (error) {
    throw new Error(
      'The Firebase CLI credentials could not be read. Install the CLI ' +
        'dependencies (npm install) or set FIREBASE_CLIENT_ID and ' +
        `FIREBASE_CLIENT_SECRET: ${error.message}`,
    );
  }
}

async function accessToken() {
  const { clientId, clientSecret } = cliCredentials();
  const store = JSON.parse(readFileSync(CONFIGSTORE, 'utf8'));
  const refreshToken = store?.tokens?.refresh_token;
  if (!refreshToken) {
    throw new Error(
      'The Firebase CLI has no refresh token. Run `firebase login` first.',
    );
  }
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      scope: SCOPE,
    }),
  });
  const body = await response.json();
  if (!response.ok || !body.access_token) {
    throw new Error(
      `Could not refresh the Firebase CLI token: ${body.error || response.status} ` +
        `${body.error_description || ''}`.trim(),
    );
  }
  return body.access_token;
}

async function identityToolkit(token, path, init) {
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/admin/v2/projects/${PROJECT_ID}${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init?.headers || {}),
      },
    },
  );
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    throw new Error(
      `Identity Toolkit ${init?.method || 'GET'} ${path} failed: ` +
        `${response.status} ${body.error?.message || text}`,
    );
  }
  return body;
}

function providersOf(config) {
  const signIn = config.signIn || {};
  const enabled = [];
  for (const [name, value] of Object.entries(signIn)) {
    if (!value || typeof value !== 'object') continue;
    if (value.enabled === true) enabled.push(name);
  }
  return enabled.sort();
}
async function main() {
  const command = process.argv[2] || 'status';
  const token = await accessToken();
  const config = await identityToolkit(token, '/config');

  if (command === 'status') {
    console.log(`project: ${PROJECT_ID}`);
    console.log(`enabled providers: ${providersOf(config).join(', ') || '(none)'}`);
    const phone = config.signIn?.phoneNumber;
    console.log(`phone: enabled=${phone?.enabled === true}`);
    const email = config.signIn?.email;
    console.log(
      `email/password: enabled=${email?.enabled === true} ` +
        `passwordRequired=${email?.passwordRequired !== false}`,
    );
    const google = config.signIn?.google;
    console.log(
      `google: enabled=${google?.enabled === true} ` +
        `clientId=${google?.clientId || '(none)'}`,
    );
    // A provider which was configured with the Identity Platform lives in
    // `defaultSupportedIdpConfigs` and not in the legacy `signIn` block.
    const supportedIdps = config.defaultSupportedIdpConfigs || {};
    for (const [idp, value] of Object.entries(supportedIdps)) {
      console.log(
        `defaultSupportedIdpConfigs.${idp}: enabled=${value?.enabled === true} ` +
          `clientId=${value?.clientId || '(none)'}`,
      );
    }
    const regions = config.smsRegionConfig || {};
    if (regions.allowlistOnly) {
      console.log(
        `sms regions: allowlistOnly -> ` +
          `${(regions.allowlistOnly.allowedRegions || []).join(', ') || '(EMPTY - no region may receive SMS)'}`,
      );
    } else if (regions.allowByDefault) {
      console.log(
        `sms regions: allowByDefault -> disallowed ` +
          `${(regions.allowByDefault.disallowedRegions || []).join(', ') || '(none)'}`,
      );
    } else {
      console.log('sms regions: (unset - the platform default applies)');
    }
    return;
  }

  const mask = [];
  const patch = { signIn: {} };

  if (command === 'enable-phone') {
    // The test-phone list is left untouched: the project has none, and the
    // live proof must come from a real SMS.
    patch.signIn.phone = { enabled: true };
    mask.push('signIn.phone.enabled');
  } else if (command === 'enable-email-password') {
    patch.signIn.email = { enabled: true, passwordRequired: true };
    mask.push('signIn.email.enabled', 'signIn.email.passwordRequired');
  } else if (command === 'enable-google') {
    const webClientId = process.argv[3];
    if (!webClientId) {
      throw new Error('enable-google needs the Web OAuth client id.');
    }
    patch.signIn.google = { enabled: true, clientId: webClientId };
    mask.push('signIn.google.enabled', 'signIn.google.clientId');
  } else if (command === 'enable-sms-regions') {
    // The project shipped with an empty SMS allowlist, which makes the
    // Identity Platform refuse every phone challenge with
    // "SMS unable to be sent until this region enabled by the app developer".
    const regions = (process.argv[3] || '')
      .split(',')
      .map((code) => code.trim().toUpperCase())
      .filter(Boolean);
    if (regions.length === 0) {
      throw new Error('enable-sms-regions needs a comma-separated region list.');
    }
    for (const code of regions) {
      if (!/^[A-Z]{2}$/.test(code)) {
        throw new Error(`"${code}" is not a two-letter CLDR region code.`);
      }
    }
    patch.smsRegionConfig = {
      allowlistOnly: { allowedRegions: regions },
    };
    mask.push('smsRegionConfig.allowlistOnly.allowedRegions');
  } else {
    throw new Error(`Unknown command: ${command}`);
  }

  await identityToolkit(token, '/config?updateMask=' + encodeURIComponent(mask.join(',')), {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });

  const updated = await identityToolkit(token, '/config');
  console.log(`updated: ${mask.join(', ')}`);
  console.log(`enabled providers now: ${providersOf(updated).join(', ') || '(none)'}`);
  const regions = updated.smsRegionConfig || {};
  if (regions.allowlistOnly) {
    console.log(
      `sms regions now: ${(regions.allowlistOnly.allowedRegions || []).join(', ') || '(empty)'}`,
    );
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
