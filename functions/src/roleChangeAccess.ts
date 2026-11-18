import { paymentAlreadyMade } from './bookingAccess';
import { isActiveBookingStatus } from './bookings';

/** Booking states which are still waiting for money or activation. */
export const OPEN_BOOKING_STATUSES = [
  'pending',
  'studentConfirmed',
  'ownerConfirmed',
];

/** What a role change has to do with one booking request. */
export type RoleChangeRequestEffect =
  | 'keep'
  | 'cancel'
  | 'block-active'
  | 'block-payment';

/**
 * Decides how one request is affected by a role change.
 *
 * The decision is pure so the security rule can be regression-tested without
 * starting the Firestore emulator. A request which is already active, or for
 * which a payment was submitted, blocks the role change: the money and the
 * occupancy have to be settled first. An open request is cancelled because
 * its tenant is no longer eligible under the new role.
 */
export function roleChangeRequestEffect(
  currentRole: string,
  targetRole: string,
  request: Record<string, any>,
): RoleChangeRequestEffect {
  // A no-op role update must not cancel anything.
  if (currentRole === targetRole) return 'keep';

  const status = String(request.status || '');
  if (isActiveBookingStatus(status)) return 'block-active';
  if (paymentAlreadyMade(request)) return 'block-payment';
  if (OPEN_BOOKING_STATUSES.indexOf(status) >= 0) return 'cancel';

  return 'keep';
}
