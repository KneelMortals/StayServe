import * as firestore from 'firebase-admin/firestore';
import * as functions from 'firebase-functions/v1';

// Creates the default Firebase app before this module opens Firestore —
// see the comment in `./firebase.ts`.
import './firebase';

import { isValidMonthlyRent } from './roomValidation';

const db = firestore.getFirestore();

/**
 * Platform-wide money settings.
 *
 * These live in their own module because both the payment functions and the
 * join-request functions need them — and because there must be exactly **one**
 * implementation of "how much is the platform fee", otherwise the amount the
 * student is quoted and the amount that is actually charged can drift apart.
 */

/** The documented fallback when no valid platform fee is configured. */
export const DEFAULT_PLATFORM_FEE_PERCENTAGE = 30;

/** Whether a value is a usable platform-fee percentage. */
export function isValidFeePercentage(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
  );
}

/** Parses and validates a configured platform-fee percentage. */
export function parsePlatformFeePercentage(
  raw: string,
  fallback = DEFAULT_PLATFORM_FEE_PERCENTAGE,
): number {
  const trimmed = raw.trim();
  if (!trimmed) return fallback;

  const value = Number(trimmed);
  return isValidFeePercentage(value) ? value : fallback;
}

/**
 * Parses the environment fallback once.
 *
 * A malformed value must never become `NaN`, a negative fee or a fee above
 * 100 %. Those values would corrupt payment intents and invoices. Invalid
 * configuration falls back to the documented default and is logged so the
 * operator can correct it.
 */
function configuredFeePercentage(): number {
  const raw = (process.env.PLATFORM_FEE_PERCENTAGE || '').trim();
  if (!raw) return DEFAULT_PLATFORM_FEE_PERCENTAGE;

  const value = Number(raw);
  if (isValidFeePercentage(value)) return value;

  console.error(
    `Invalid PLATFORM_FEE_PERCENTAGE=${JSON.stringify(raw)}; ` +
      `using ${DEFAULT_PLATFORM_FEE_PERCENTAGE} instead.`,
  );
  return DEFAULT_PLATFORM_FEE_PERCENTAGE;
}

/** Percentage of the monthly rent charged as the platform fee. */
export const PLATFORM_FEE_PERCENTAGE = configuredFeePercentage();

/**
 * The UPI address that receives every payment collected through the app.
 *
 * This is the **only** UPI in the system: the room owner never has to
 * upload one. The platform collects the fee on this address and the owner
 * settles their share with the platform.
 */
export const PLATFORM_UPI_VPA =
  process.env.PLATFORM_UPI_VPA || 'shauryaprataprai461-2@oksbi';

/** Payee name shown inside the UPI app. */
export const PLATFORM_UPI_NAME = process.env.PLATFORM_UPI_NAME || 'StayServe';

/**
 * Who pays the platform fee of a booking.
 *
 *  - `student` — the student pays the fee to the platform's UPI when they
 *    book the room.
 *  - `owner`   — the room owner pays the fee to the platform's UPI. The
 *    student is told that the owner settles it.
 *
 * The admin can switch between the two from Admin → Settings
 * (`settings/platform/feePayer`). It defaults to `owner`, which is the
 * business model the platform runs on: the cut is taken **once**, on the
 * first payment of a booking, and after that everything goes straight from
 * the student to the room owner.
 */
export type FeePayer = 'student' | 'owner';

export async function resolveFeePayer(): Promise<FeePayer> {
  try {
    const snapshot = await db.collection('settings').doc('platform').get();
    const value = snapshot.get('feePayer');
    if (value === 'student' || value === 'owner') return value;
  } catch (error) {
    console.error('Failed to read the platform fee payer:', error);
    throw new functions.https.HttpsError(
      'failed-precondition',
      'The platform fee settings could not be read. Please try again.',
    );
  }
  return 'owner';
}

/**
 * Resolves the platform fee percentage.
 *
 * The admin can change it from the app, which writes
 * `settings/platform/commissionPercentage`. When that document does not
 * exist the `PLATFORM_FEE_PERCENTAGE` environment variable is used, which is
 * also the default the client falls back to.
 *
 * A percentage of `0` is valid (the platform may waive the fee), so the
 * check is `>= 0` — treating `0` as "invalid" would silently charge 30 %
 * after the admin had deliberately set the fee to zero.
 */
export async function resolveFeePercentage(): Promise<number> {
  try {
    const snapshot = await db.collection('settings').doc('platform').get();
    const value = snapshot.get('commissionPercentage');
    if (isValidFeePercentage(value)) return value;
  } catch (error) {
    console.error('Failed to read the platform fee setting:', error);
    throw new functions.https.HttpsError(
      'failed-precondition',
      'The platform fee settings could not be read. Please try again.',
    );
  }
  return PLATFORM_FEE_PERCENTAGE;
}

/**
 * The money terms that were agreed when a booking request was made.
 *
 * A request stores the percentage and the payer of the platform fee at the
 * moment it was created (`commissionPercentageAtJoin` and
 * `platformFeePayer`). Those are the terms the student and the owner agreed
 * on, and they are the terms that are charged — the amount the owner was
 * quoted, the amount of the UPI intent, the amount of the payment record
 * and the amount of the invoice are all based on them.
 *
 * Reading the *current* setting instead would be wrong: the admin can
 * change the percentage or the payer at any moment, and then a booking that
 * is already waiting for its payment would suddenly ask for a different
 * amount — or for a different party to pay it.
 *
 * A request of an older version of the app has no snapshot, so the current
 * setting is used for those.
 */
/**
 * Resolves the agreed terms from an already-read request and settings value.
 *
 * Transactions need a synchronous, snapshot-based version of this logic:
 * reading the settings document outside the transaction could return terms
 * that changed before the booking was committed.
 */
export function resolveAgreedTermsFromData(
  request: Record<string, any>,
  settings: Record<string, any> | undefined,
): { percentage: number; payer: FeePayer } {
  const snapshotValue = request.commissionPercentageAtJoin;
  const snapshotPercentage =
    typeof snapshotValue === 'number'
      ? snapshotValue
      : typeof snapshotValue === 'string' && snapshotValue.trim() !== ''
        ? Number(snapshotValue)
        : Number.NaN;
  const percentage = isValidFeePercentage(snapshotPercentage)
    ? snapshotPercentage
    : isValidFeePercentage(settings?.commissionPercentage)
      ? settings.commissionPercentage
      : PLATFORM_FEE_PERCENTAGE;

  const snapshotPayer = String(request.platformFeePayer || '');
  const payer: FeePayer =
    snapshotPayer === 'student' || snapshotPayer === 'owner'
      ? snapshotPayer
      : settings?.feePayer === 'student' || settings?.feePayer === 'owner'
        ? settings.feePayer
        : 'owner';

  return { percentage, payer };
}

/**
 * Resolves the platform fee percentage and payer for a booking request.
 *
 * The settings document is read once so both values come from the same
 * server-side snapshot.
 */
export async function resolveAgreedTerms(
  request: Record<string, any>,
): Promise<{ percentage: number; payer: FeePayer }> {
  const snapshotValue = request.commissionPercentageAtJoin;
  const snapshotPercentage =
    typeof snapshotValue === 'number'
      ? snapshotValue
      : typeof snapshotValue === 'string' && snapshotValue.trim() !== ''
        ? Number(snapshotValue)
        : Number.NaN;
  const snapshotPayer = String(request.platformFeePayer || '');
  const hasSnapshotPercentage = isValidFeePercentage(snapshotPercentage);
  const hasSnapshotPayer =
    snapshotPayer === 'student' || snapshotPayer === 'owner';

  // A complete agreement snapshot does not depend on the live settings
  // document. This keeps an existing booking payable during a settings read
  // outage and preserves the terms that were agreed when it was made.
  if (hasSnapshotPercentage && hasSnapshotPayer) {
    return {
      percentage: snapshotPercentage,
      payer: snapshotPayer as FeePayer,
    };
  }

  try {
    const snapshot = await db.collection('settings').doc('platform').get();
    return resolveAgreedTermsFromData(
      request,
      snapshot.data() as Record<string, any> | undefined,
    );
  } catch (error) {
    console.error('Failed to read the platform fee settings:', error);
    throw new functions.https.HttpsError(
      'failed-precondition',
      'The platform fee settings could not be read. Please try again.',
    );
  }
}

/**
 * The platform fee for a monthly rent.
 *
 * Rounded to whole rupees — this is the single definition of the amount, and
 * the client uses the very same rounding so the invoice, the payment and the
 * screen the student sees always agree.
 */
export function platformFeeFor(monthlyRent: number, percentage: number): number {
  if (!isValidMonthlyRent(monthlyRent)) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'The rent for this booking is not valid',
    );
  }
  if (!isValidFeePercentage(percentage)) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'The platform fee percentage is not valid',
    );
  }

  const amount = Math.round((monthlyRent * percentage) / 100);
  if (percentage > 0 && amount <= 0) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'The platform fee percentage does not produce a valid amount',
    );
  }
  return amount;
}

/**
 * Whether the platform may send notifications.
 *
 * The admin can switch this off from Admin → Settings. It is honoured by
 * every server-side notification, so the switch really does something.
 */
export async function areNotificationsEnabled(): Promise<boolean> {
  try {
    const snapshot = await db.collection('settings').doc('platform').get();
    const value = snapshot.get('notificationsEnabled');
    if (typeof value === 'boolean') return value;
  } catch (error) {
    console.error('Failed to read the notifications setting:', error);
    // Notification settings fail closed. An operational error must not turn
    // into an unexpected push to every affected account.
    return false;
  }
  return true;
}
