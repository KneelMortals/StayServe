import * as authSdk from 'firebase-admin/auth';

import { publishLatestRoleClaims } from './roleClaims';
import {
  claimedVerifiedPhone,
  hasLivePhoneProvider,
  phoneProviderTokenFacts,
  readPhoneVerificationProof,
  verifiedPhoneForUser,
  writePhoneVerificationProof,
  clearPhoneVerificationProof,
} from './verifiedPhone';

/**
 * Records the proof that the caller completed Firebase's phone challenge.
 *
 * Firebase Auth does not tell the Admin SDK whether a phone number was
 * attached by `PhoneAuthProvider` — which only links a number after the owner
 * proved control of it — or by the Admin SDK, which skips the SMS challenge
 * completely. A non-empty `phoneNumber` is therefore **not** a verification
 * proof.
 *
 * The server accepts a proof only when the presented ID token was minted by a
 * phone-provider session for exactly the phone which Firebase currently has
 * linked to the account. Firebase issues such a token only after the SMS
 * challenge was completed, so an administrator-provisioned number never
 * satisfies this check.
 *
 * The proof is stored twice:
 *
 *   * in the server-only `phoneVerificationProofs` document, which is the
 *     durable source of truth, and
 *   * in the signed `stayServeVerifiedPhone` custom claim, which the
 *     Firestore and Storage rules evaluate.
 *
 * The function is idempotent and returns the verified number, or an empty
 * string when the presented token is not a phone-provider proof.
 */
export async function recordPhoneVerificationProof(options: {
  uid: string;
  token: unknown;
}): Promise<string> {
  const { uid, token } = options;
  if (!uid) return '';

  const facts = phoneProviderTokenFacts(token);
  if (!facts) return '';

  let user: authSdk.UserRecord;
  try {
    user = await authSdk.getAuth().getUser(uid);
  } catch (error) {
    console.error(
      `Could not read the live Firebase Auth identity of ${uid}:`,
      error,
    );
    return '';
  }

  const livePhone = String(user.phoneNumber || '').trim();
  if (!livePhone || livePhone !== facts.phone) return '';

  // The live account must really have the phone provider linked. A record
  // which only carries a phone attribute without the provider is not a
  // completed phone challenge.
  if (!hasLivePhoneProvider(user)) return '';

  const proofPhone = await readPhoneVerificationProof(uid);
  if (proofPhone !== livePhone) {
    await writePhoneVerificationProof(uid, livePhone);
  }

  // Publish the signed projection of the proof so that the Firestore and
  // Storage rules can evaluate it. The publication also carries the role
  // claim, so the two facts can never drift apart.
  //
  // A failed publication is not fatal: the durable proof is already stored
  // and the next profile synchronisation republishes the claim.
  if (claimedVerifiedPhone(user) !== livePhone) {
    try {
      await publishLatestRoleClaims(uid);
    } catch (error) {
      console.error(
        `Could not publish the verified-phone claim of ${uid}:`,
        error,
      );
    }
  }

  return livePhone;
}

/**
 * Removes a proof which no longer belongs to the live Auth phone.
 *
 * The number may have been unlinked or replaced by an administrator. The
 * durable proof and the signed claim are then stale and are removed so that
 * they cannot keep granting access after the next token refresh.
 */
export async function revokeStaleVerifiedPhone(
  uid: string,
  user: {
    phoneNumber?: string | null;
    customClaims?: Record<string, unknown> | null;
  },
): Promise<void> {
  if (!uid) return;
  const livePhone = String(user?.phoneNumber || '').trim();
  const proofPhone = await readPhoneVerificationProof(uid);
  const rawClaim = String(
    (user?.customClaims as Record<string, unknown> | null | undefined)?.[
      'stayServeVerifiedPhone'
    ] || '',
  ).trim();

  const staleProof = Boolean(proofPhone) && proofPhone !== livePhone;
  const staleClaim = Boolean(rawClaim) && rawClaim !== livePhone;
  if (!staleProof && !staleClaim) return;

  if (staleProof) {
    await clearPhoneVerificationProof(uid);
  }
  try {
    await publishLatestRoleClaims(uid);
  } catch (error) {
    // The stale proof is already gone. A failed republication only means
    // that the signed claim stays in the already issued tokens until they
    // expire; the number it names no longer matches the live phone.
    console.error(
      `Could not revoke the verified-phone claim of ${uid}:`,
      error,
    );
  }
}

/**
 * The verified phone of a live Auth record.
 *
 * Both the durable proof and the signed claim are server-owned facts which
 * are bound to the live phone number. A number which was merely attached by
 * the Admin SDK has neither and is therefore not verified.
 */
export async function liveVerifiedPhoneFor(
  user: authSdk.UserRecord,
): Promise<string> {
  const proofPhone = await readPhoneVerificationProof(user.uid);
  return verifiedPhoneForUser(user, proofPhone);
}
