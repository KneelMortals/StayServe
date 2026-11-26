import * as firestore from 'firebase-admin/firestore';
import * as crypto from 'crypto';

import {
  legacyEmailProofMatches,
  LEGACY_EMAIL_PROOF_SOURCE,
} from './authIdentity';
import {
  readPhoneVerificationProof,
  verifiedPhoneForUser,
} from './verifiedPhone';

// Creates the default Firebase app before this module opens Firestore —
// see the comment in `./firebase.ts`.
import './firebase';

const db = firestore.getFirestore();

/** The subset of a Firebase Auth user needed to seed a StayServe profile. */
export interface AuthProfileBootstrapSource {
  uid: string;
  displayName?: string | null;
  email?: string | null;
  emailVerified?: boolean;
  phoneNumber?: string | null;
  customClaims?: Record<string, unknown> | null;
  providerData?: Array<{ providerId?: string | null }>;
}

export type ProfileBootstrapResult =
  | 'created'
  | 'repaired'
  | 'preserved'
  | 'skipped';

function providerIds(user: AuthProfileBootstrapSource): string[] {
  return Array.from(
    new Set(
      (user.providerData || [])
        .map((provider) => String(provider.providerId || '').trim())
        .filter((providerId) => providerId.length > 0),
    ),
  ).sort();
}

/**
 * The deterministic id of the durable account-deletion job for one uid.
 *
 * This mirrors the id used by the account-deletion state machine. The
 * completed job redacts its uid, but its deterministic id remains a durable
 * tombstone which a delayed Auth-create trigger can still recognise.
 */
function accountDeletionJobId(uid: string): string {
  const digest = crypto
    .createHash('sha256')
    .update(uid.trim())
    .digest('hex');
  return `account-deletion-${digest}`;
}

/** Whether a durable deletion marker forbids a delayed profile bootstrap. */
function bootstrapMustBeSkipped(
  rollbackSnapshot: firestore.DocumentSnapshot,
  deletionJobSnapshot: firestore.DocumentSnapshot,
): boolean {
  const rollbackStatus = String(
    rollbackSnapshot.get('status') || '',
  ).trim();
  if (
    rollbackStatus === 'rollbackRequested' ||
    rollbackStatus === 'authDeleted'
  ) {
    return true;
  }

  const deletionStatus = String(
    deletionJobSnapshot.get('status') || '',
  ).trim();
  return (
    deletionStatus === 'scheduled' ||
    deletionStatus === 'pending' ||
    deletionStatus === 'processing' ||
    deletionStatus === 'completed'
  );
}

/**
 * Whether a profile already has the complete server-owned shape.
 *
 * A retry of the Auth trigger sees the document which it created itself and
 * must leave it untouched. A partial document — most notably the old client
 * bootstrap which wrote only `fcmToken` — does not have this shape and is
 * repaired below.
 */
export function hasCompleteProfileBootstrap(
  data: Record<string, unknown> | undefined,
  uid: string,
): boolean {
  if (!data) return false;
  return (
    String(data.uid || '') === uid &&
    typeof data.registrationCompleted === 'boolean' &&
    typeof data.roleClaimed === 'boolean' &&
    typeof data.isActive === 'boolean' &&
    typeof data.role === 'string' &&
    Array.isArray(data.authProviders) &&
    data.createdAt !== undefined
  );
}

/**
 * Creates or repairs the server-owned profile of a newly created Auth user.
 *
 * Older clients used a Firestore `set(..., merge: true)` to bootstrap the FCM
 * token. If that write won the race with this trigger, it left a document
 * which contained only the token and `updatedAt`. The old trigger treated
 * every existing document as authoritative and left the malformed profile in
 * place forever; the registration callables then failed closed because the
 * document had no explicit registration marker.
 *
 * The repair fills the missing server-owned fields from live Firebase Auth.
 * It preserves an already selected owner role and an explicit inactive state,
 * but never accepts a client-written administrator role.
 */
export async function ensureUserProfile(
  user: AuthProfileBootstrapSource,
): Promise<ProfileBootstrapResult> {
  const userRef = db.collection('users').doc(user.uid);
  const rollbackRef = db
    .collection('registrationRollbackOperations')
    .doc(user.uid);
  const deletionJobRef = db
    .collection('accountDeletionJobs')
    .doc(accountDeletionJobId(user.uid));
  const authProviders = providerIds(user);
  const liveEmail = String(user.email || '').trim().toLowerCase();
  // A non-empty Firebase phone number is not a verification proof: the Admin
  // SDK can attach a number without the SMS challenge. The profile therefore
  // starts out unverified unless the server already holds a proof for exactly
  // this number.
  const proofPhone = await readPhoneVerificationProof(user.uid);
  const verifiedPhone = verifiedPhoneForUser(user, proofPhone);
  const livePhone = String(user.phoneNumber || '').trim();
  const phoneVerified = Boolean(verifiedPhone) && verifiedPhone === livePhone;

  return db.runTransaction(async (transaction) => {
    const [snapshot, rollbackSnapshot, deletionJobSnapshot] = await Promise.all([
      transaction.get(userRef),
      transaction.get(rollbackRef),
      transaction.get(deletionJobRef),
    ]);

    // Firebase can deliver an Auth-create event long after the client rolled
    // the incomplete sign-up back or after the account-deletion worker
    // removed the account. Creating a fresh profile in that window would
    // resurrect a deleted uid and defeat the durable rollback/deletion fence.
    if (bootstrapMustBeSkipped(rollbackSnapshot, deletionJobSnapshot)) {
      return 'skipped';
    }

    if (!snapshot.exists) {
      transaction.create(userRef, {
        uid: user.uid,
        name: String(user.displayName || '').trim() || 'User',
        email: liveEmail,
        emailVerified: liveEmail !== '' && user.emailVerified === true,
        phone: String(user.phoneNumber || '') || null,
        phoneVerified,
        phoneVerifiedAt: phoneVerified
          ? firestore.FieldValue.serverTimestamp()
          : null,
        authProviders,
        role: 'student',
        roleClaimed: false,
        isActive: true,
        registrationCompleted: false,
        createdAt: firestore.FieldValue.serverTimestamp(),
        updatedAt: firestore.FieldValue.serverTimestamp(),
        savedRooms: [],
      });
      return 'created';
    }

    const existing = (snapshot.data() || {}) as Record<string, unknown>;
    if (hasCompleteProfileBootstrap(existing, user.uid)) {
      return 'preserved';
    }

    const existingRole = String(existing.role || '').trim().toLowerCase();
    const preserveOwner = existingRole === 'owner';
    const existingName = String(existing.name || '').trim();
    const existingCreatedAt = existing.createdAt;
    const existingSavedRooms = Array.isArray(existing.savedRooms)
      ? existing.savedRooms
      : [];
    const legacyProofMatches = legacyEmailProofMatches(existing, liveEmail);

    transaction.set(
      userRef,
      {
        uid: user.uid,
        name: existingName || String(user.displayName || '').trim() || 'User',
        // The live Firebase Auth facts are authoritative for contact details.
        email: liveEmail,
        emailVerified: liveEmail !== '' && user.emailVerified === true,
        legacyEmailProofSource: legacyProofMatches
          ? LEGACY_EMAIL_PROOF_SOURCE
          : null,
        legacyEmailProofEmail: legacyProofMatches ? liveEmail : null,
        phone: String(user.phoneNumber || '') || null,
        phoneVerified,
        phoneVerifiedAt: phoneVerified
          ? firestore.FieldValue.serverTimestamp()
          : null,
        authProviders,
        // A client-written admin role is never preserved. An owner role is
        // evidence of an earlier legitimate selection and is locked instead.
        role: preserveOwner ? 'owner' : 'student',
        roleClaimed:
          preserveOwner ||
          (existing.roleClaimed === true &&
            existing.registrationCompleted === true)
            ? true
            : false,
        isActive: typeof existing.isActive === 'boolean' ? existing.isActive : true,
        registrationCompleted:
          typeof existing.registrationCompleted === 'boolean'
            ? existing.registrationCompleted
            : false,
        createdAt:
          existingCreatedAt === undefined
            ? firestore.FieldValue.serverTimestamp()
            : existingCreatedAt,
        savedRooms: existingSavedRooms,
        updatedAt: firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return 'repaired';
  });
}
