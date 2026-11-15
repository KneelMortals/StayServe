import * as admin from 'firebase-admin';

// Creates the default Firebase app before this module opens Firestore —
// see the comment in `./firebase.ts`.
import './firebase';

const db = admin.firestore();

/**
 * Platform-wide money settings.
 *
 * These live in their own module because both the payment functions and the
 * join-request functions need them — and because there must be exactly **one**
 * implementation of "how much is the platform fee", otherwise the amount the
 * student is quoted and the amount that is actually charged can drift apart.
 */

/** Percentage of the monthly rent charged as the platform fee. */
export const PLATFORM_FEE_PERCENTAGE = Number(
  process.env.PLATFORM_FEE_PERCENTAGE || '30',
);

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
    if (typeof value === 'number' && value >= 0 && value <= 100) {
      return value;
    }
  } catch (error) {
    console.error('Failed to read the platform fee setting:', error);
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
export async function resolveAgreedTerms(
  request: Record<string, any>,
): Promise<{ percentage: number; payer: FeePayer }> {
  const snapshotPercentage = Number(request.commissionPercentageAtJoin);
  const percentage =
    Number.isFinite(snapshotPercentage) &&
    snapshotPercentage >= 0 &&
    snapshotPercentage <= 100
      ? snapshotPercentage
      : await resolveFeePercentage();

  const snapshotPayer = String(request.platformFeePayer || '');
  const payer: FeePayer =
    snapshotPayer === 'student' || snapshotPayer === 'owner'
      ? snapshotPayer
      : await resolveFeePayer();

  return { percentage, payer };
}

/**
 * The platform fee for a monthly rent.
 *
 * Rounded to whole rupees — this is the single definition of the amount, and
 * the client uses the very same rounding so the invoice, the payment and the
 * screen the student sees always agree.
 */
export function platformFeeFor(monthlyRent: number, percentage: number): number {
  return Math.round((monthlyRent * percentage) / 100);
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
  }
  return true;
}
