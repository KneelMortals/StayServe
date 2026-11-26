// Shared App Check support for live callable probes.
//
// Callable enforcement is controlled by the deployed Functions environment.
// While it is disabled, the token is optional. Once enforcement is enabled,
// export STAYSERVE_APP_CHECK_TOKEN and set STAYSERVE_REQUIRE_APP_CHECK=1 so
// every live probe fails before it creates an account when the token is
// missing.

const APP_CHECK_TOKEN = String(
  process.env.STAYSERVE_APP_CHECK_TOKEN || '',
).trim();
const REQUIRE_APP_CHECK = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.STAYSERVE_REQUIRE_APP_CHECK || '').trim().toLowerCase(),
);

export function appCheckHeaders(headers = {}, token = APP_CHECK_TOKEN) {
  if (!token) return { ...headers };
  return {
    ...headers,
    'X-Firebase-AppCheck': token,
  };
}

export function assertAppCheckConfigured(
  token = APP_CHECK_TOKEN,
  required = REQUIRE_APP_CHECK,
) {
  if (required && !token) {
    throw new Error(
      'STAYSERVE_REQUIRE_APP_CHECK is enabled but ' +
        'STAYSERVE_APP_CHECK_TOKEN is missing.',
    );
  }
}
