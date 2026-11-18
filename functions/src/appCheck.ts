import * as functions from 'firebase-functions/v1';

/**
 * App Check enforcement for callable functions.
 *
 * The rollout is deliberately controlled by one environment variable:
 *
 *   APP_CHECK_ENFORCE=true
 *
 * It is **false by default**. That keeps the current production clients,
 * the emulator and the local test suite working while the Android and iOS
 * apps are registered with Firebase App Check. Once the providers and the
 * debug tokens are ready, the variable can be enabled and the functions
 * redeployed.
 *
 * The client always attempts to activate App Check. A provider failure is
 * logged and does not stop the app from opening; the server-side switch is
 * the final gate which decides whether a missing token is rejected.
 */
export function appCheckEnforcementRequested(value: unknown): boolean {
  return ['1', 'true', 'yes', 'on'].includes(
    String(value ?? '').trim().toLowerCase(),
  );
}

export const appCheckEnforcementEnabled = appCheckEnforcementRequested(
  process.env.APP_CHECK_ENFORCE,
);

export const callableHttps = functions.runWith({
  enforceAppCheck: appCheckEnforcementEnabled,
}).https;
