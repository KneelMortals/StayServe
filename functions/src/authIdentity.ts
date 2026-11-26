import type { UserRecord } from 'firebase-admin/auth';

/**
 * The source marker for the legacy StayServe one-time email proof.
 *
 * The proof may authorise a registration, but it is not Firebase Auth's
 * `emailVerified` fact. Keeping it under a separate name prevents a stale
 * legacy flag from granting the same authority as a live Auth verification.
 */
export const LEGACY_EMAIL_PROOF_SOURCE = 'stayServeOtp';

/**
 * The identity facts which StayServe copies from Firebase Auth.
 *
 * The server reads the live Auth user record, and only trusted server code
 * may decide whether an email address or a phone number is verified. The
 * Firestore profile is just a server-owned copy of these facts; a client can
 * never set the verification flags itself.
 */
export interface FirebaseAuthIdentity {
  /** The lower-case email address in the live Auth record, or an empty string. */
  email: string;

  /** Whether Firebase says that the email address is verified. */
  emailVerified: boolean;

  /** The E.164 phone number in the live Auth record, or an empty string. */
  phone: string;

  /**
   * Whether the phone number is a verified Firebase phone identity.
   *
   * A non-empty `phoneNumber` is **not** a verification proof: the Admin SDK
   * can attach a number without the SMS challenge. The number is only
   * verified when the server recorded a proof for exactly this number.
   */
  phoneVerified: boolean;

  /** Every provider linked to the account, in a stable order. */
  providers: string[];
}

/**
 * Reads the identity facts from the **live** Firebase Auth user record.
 *
 * An ID token is a snapshot which can remain cryptographically valid for a
 * short time after a provider is linked or unlinked. The user record is the
 * authority for the contacts which are currently attached to the account.
 * In particular, `phoneNumber` is present only while a phone provider is
 * linked, and `emailVerified` describes the live primary email.
 *
 * `verifiedPhone` is the number for which the server holds a proof that the
 * owner completed Firebase's phone challenge. It is deliberately a separate
 * argument: the live record alone cannot distinguish a verified number from
 * one which an administrator attached with the Admin SDK.
 */
export function firebaseIdentityFromAuthUser(
  user: UserRecord,
  verifiedPhone = '',
): FirebaseAuthIdentity {
  const email = String(user.email || '').trim().toLowerCase();
  const emailVerified = email !== '' && user.emailVerified === true;
  const phone = String(user.phoneNumber || '').trim();
  const providers = Array.from(
    new Set(
      (user.providerData || [])
        .map((provider) => String(provider.providerId || '').trim())
        .filter((provider) => provider.length > 0),
    ),
  ).sort();
  const proof = String(verifiedPhone || '').trim();

  return {
    email,
    emailVerified,
    phone,
    // The phone is verified only when the server holds a proof for exactly
    // this number. An Admin-provisioned number has no proof and therefore
    // never grants tenant access.
    phoneVerified: phone !== '' && proof !== '' && proof === phone,
    providers,
  };
}

/**
 * Whether the account has a contact which the server may use to complete a
 * registration.
 *
 * A phone-only account does not need an email address. An email/password or
 * Google account must have a Firebase-verified email, unless the legacy
 * StayServe email OTP challenge proves it separately.
 */
export function hasVerifiedRegistrationContact(
  identity: FirebaseAuthIdentity,
  emailChallengeVerified: boolean,
): boolean {
  return identity.phoneVerified || identity.emailVerified || emailChallengeVerified;
}

/**
 * Whether a profile still contains a legacy email proof for one address.
 *
 * The marker is useful as historical registration evidence, but it never
 * turns into `emailVerified`. It also stops matching as soon as Firebase Auth
 * reports a different live address.
 */
export function legacyEmailProofMatches(
  profile: Record<string, unknown>,
  liveEmail: string,
): boolean {
  const normalizedEmail = liveEmail.trim().toLowerCase();
  if (!normalizedEmail) return false;
  return (
    String(profile.legacyEmailProofSource || '').trim() ===
      LEGACY_EMAIL_PROOF_SOURCE &&
    String(profile.legacyEmailProofEmail || '').trim().toLowerCase() ===
      normalizedEmail
  );
}
