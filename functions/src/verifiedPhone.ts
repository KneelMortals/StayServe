import * as firestore from 'firebase-admin/firestore';
import type { UserRecord } from 'firebase-admin/auth';

// Creates the default Firebase app before this module opens Firestore —
// see the comment in `./firebase.ts`.
import './firebase';

const db = firestore.getFirestore();

/**
 * The signed custom claim which binds a verified phone to one account.
 *
 * Firebase Auth itself does not expose whether a phone number was attached by
 * the Admin SDK (which skips the SMS challenge) or by `PhoneAuthProvider`
 * (which only links a number after the owner proved control of it). The
 * server therefore records its own proof and publishes it as a signed claim.
 *
 * The claim stores the **number** instead of a boolean. A boolean would keep
 * granting access after an administrator replaced the number on the account;
 * the bound number stops as soon as the live Auth phone differs.
 */
export const VERIFIED_PHONE_CLAIM = 'stayServeVerifiedPhone';

/**
 * The server-only durable proof collection.
 *
 * One document per account records that the account completed Firebase's
 * phone challenge for one exact number. The document is written only by the
 * server, after it has seen a phone-provider ID token for the same account.
 * The signed claim above is the projection which Firestore and Storage rules
 * can evaluate; this document is the durable source which survives a lost
 * claim publication.
 */
export const PHONE_VERIFICATION_PROOFS = 'phoneVerificationProofs';

/** The phone facts carried by a phone-provider ID token. */
export interface PhoneProviderTokenFacts {
  /** The E.164 number which Firebase proved for the session. */
  phone: string;
}

/**
 * Extracts the phone facts from an ID token which was minted by a Firebase
 * phone-provider session.
 *
 * `firebase.sign_in_provider` is `phone` only when the current session was
 * authenticated by the phone provider. Firebase issues such a token only after
 * the SMS challenge (or an equivalent temporary proof) was completed, so it
 * is the server-visible difference between a genuinely verified number and a
 * number which was attached by the Admin SDK.
 */
export function phoneProviderTokenFacts(
  token: unknown,
): PhoneProviderTokenFacts | null {
  if (!token || typeof token !== 'object') return null;
  const claims = token as Record<string, any>;
  const firebaseClaim = claims.firebase;
  if (!firebaseClaim || typeof firebaseClaim !== 'object') return null;
  const provider = String(firebaseClaim.sign_in_provider || '')
    .trim()
    .toLowerCase();
  if (provider !== 'phone') return null;
  const phone = String(claims.phone_number || '').trim();
  if (!phone) return null;
  return { phone };
}

/** The phone number of the live `phone` provider in Firebase Auth. */
export function livePhoneProviderNumber(user: {
  providerData?: Array<{ providerId?: string | null; phoneNumber?: string | null }>;
}): string {
  const providers = Array.isArray(user?.providerData) ? user.providerData : [];
  for (const provider of providers) {
    if (String(provider?.providerId || '').trim().toLowerCase() !== 'phone') {
      continue;
    }
    const phone = String(provider?.phoneNumber || '').trim();
    if (phone) return phone;
  }
  return '';
}

/**
 * Whether the live account really has the phone provider linked.
 *
 * A phone attribute without the provider is not a linked phone identity. The
 * check is a sanity check only: the Admin SDK attaches a phone *provider* as
 * well, so it cannot by itself prove that the SMS challenge happened. The
 * proof is the phone-provider session which the server records separately.
 */
export function hasLivePhoneProvider(user: {
  providerData?: Array<{ providerId?: string | null }>;
}): boolean {
  const providers = Array.isArray(user?.providerData) ? user.providerData : [];
  return providers.some(
    (provider) =>
      String(provider?.providerId || '').trim().toLowerCase() === 'phone',
  );
}

/**
 * The verified phone which the signed custom claim carries.
 *
 * The claim is only honoured while it still matches the live Auth phone. A
 * replaced or unlinked number therefore loses the grant immediately, even if
 * an already issued token still carries the old claim.
 */
export function claimedVerifiedPhone(user: {
  phoneNumber?: string | null;
  customClaims?: Record<string, unknown> | null;
}): string {
  const live = String(user?.phoneNumber || '').trim();
  if (!live) return '';
  const claim = String(
    (user?.customClaims as Record<string, unknown> | null | undefined)?.[
      VERIFIED_PHONE_CLAIM
    ] || '',
  ).trim();
  return claim && claim === live ? claim : '';
}

/**
 * The verified phone of a live Auth record.
 *
 * Either fact is enough: the durable proof document survives a lost claim
 * publication, and the signed claim survives a failed proof write. Both are
 * server-owned and both are bound to the live phone number.
 */
export function verifiedPhoneForUser(
  user: {
    phoneNumber?: string | null;
    customClaims?: Record<string, unknown> | null;
  },
  proofPhone = '',
): string {
  const claimed = claimedVerifiedPhone(user);
  if (claimed) return claimed;
  const live = String(user?.phoneNumber || '').trim();
  const proof = String(proofPhone || '').trim();
  return live && proof === live ? live : '';
}

/** The durable proof document of one account. */
export function phoneVerificationProofRef(
  uid: string,
): firestore.DocumentReference {
  return db.collection(PHONE_VERIFICATION_PROOFS).doc(uid);
}

/**
 * Reads the durable proof of one account.
 *
 * A failed read returns an empty proof. The caller then falls back to the
 * signed claim, and a total outage of both facts fails closed.
 */
export async function readPhoneVerificationProof(uid: string): Promise<string> {
  if (!uid) return '';
  try {
    const snapshot = await phoneVerificationProofRef(uid).get();
    if (!snapshot.exists) return '';
    return String(snapshot.get('phone') || '').trim();
  } catch (error) {
    console.error(`Could not read the phone-verification proof of ${uid}:`, error);
    return '';
  }
}

/**
 * Records the durable proof that the account completed the phone challenge.
 *
 * The write is idempotent: the original verification time is preserved while
 * the number stays the same.
 */
export async function writePhoneVerificationProof(
  uid: string,
  phone: string,
): Promise<void> {
  const normalized = String(phone || '').trim();
  if (!uid || !normalized) return;
  const ref = phoneVerificationProofRef(uid);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const current = snapshot.exists
      ? String(snapshot.get('phone') || '').trim()
      : '';
    if (current === normalized) {
      transaction.set(
        ref,
        { updatedAt: firestore.FieldValue.serverTimestamp() },
        { merge: true },
      );
      return;
    }
    transaction.set(
      ref,
      {
        uid,
        phone: normalized,
        provider: 'phone',
        verifiedAt: firestore.FieldValue.serverTimestamp(),
        updatedAt: firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });
}

/** Removes the durable proof of one account. */
export async function clearPhoneVerificationProof(uid: string): Promise<void> {
  if (!uid) return;
  try {
    await phoneVerificationProofRef(uid).delete();
  } catch (error) {
    console.error(`Could not clear the phone-verification proof of ${uid}:`, error);
  }
}

/**
 * The verified phone of a live Auth record, using the durable proof.
 *
 * A missing proof document is not an error: the account may never have
 * completed the phone challenge.
 */
export async function liveVerifiedPhone(
  user: UserRecord,
): Promise<string> {
  const proofPhone = await readPhoneVerificationProof(user.uid);
  return verifiedPhoneForUser(user, proofPhone);
}
