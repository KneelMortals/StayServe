/**
 * Canonical validation for the public fields of a room listing.
 *
 * The Flutter form validates these values for a good user experience, but
 * the client is never a security boundary. A modified client can write any
 * Firestore value, so the same limits are enforced by the security rules and
 * by every server-side booking transition.
 *
 * This module is deliberately pure: the rules, the callables and the unit
 * tests all use the same numeric contract.
 */

/** The smallest monthly rent the product accepts. */
export const MIN_ROOM_MONTHLY_RENT = 1000;

/** The largest monthly rent the product accepts. */
export const MAX_ROOM_MONTHLY_RENT = 1_000_000;

/** The smallest advertised capacity of a room. */
export const MIN_ROOM_OCCUPANCY = 1;

/** The largest advertised capacity of a room. */
export const MAX_ROOM_OCCUPANCY = 20;

/** Whether a value is a canonical monthly rent. */
export function isValidMonthlyRent(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= MIN_ROOM_MONTHLY_RENT &&
    value <= MAX_ROOM_MONTHLY_RENT
  );
}

/** Whether a value is a canonical, whole-number room capacity. */
export function isValidRoomCapacity(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_ROOM_OCCUPANCY &&
    value <= MAX_ROOM_OCCUPANCY
  );
}

/** Whether a value is a canonical current-occupancy counter. */
export function isValidCurrentOccupancy(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_ROOM_OCCUPANCY
  );
}

/** The capacity fields of a room, when both values are canonical. */
export interface RoomCapacityState {
  capacity: number;
  currentOccupancy: number;
}

/**
 * Reads the capacity fields of a room without coercing malformed values.
 *
 * A numeric string, a fractional capacity or a missing counter is invalid:
 * accepting it would let one listing claim more tenants than it advertised.
 */
export function readRoomCapacityState(
  room: Record<string, any>,
): RoomCapacityState | null {
  const capacity = room.occupancy;
  const currentOccupancy = room.currentOccupancy;

  if (
    !isValidRoomCapacity(capacity) ||
    !isValidCurrentOccupancy(currentOccupancy) ||
    currentOccupancy > capacity
  ) {
    return null;
  }

  return { capacity, currentOccupancy };
}

/** Why a room may not accept another booking. */
export type RoomBookingRejection =
  | 'owner-mismatch'
  | 'unavailable'
  | 'invalid-rent'
  | 'invalid-capacity'
  | 'invalid-occupancy'
  | 'full';

/** The result of checking whether a room may accept a booking. */
export type RoomBookingDecision =
  | { allowed: true; capacity: RoomCapacityState }
  | { allowed: false; reason: RoomBookingRejection };

/**
 * Decides whether a room may accept another booking.
 *
 * The listing must still be on the market, must not be being deleted, must
 * belong to the expected owner and must have a free, valid slot. The rent is
 * checked as well so a malformed listing cannot become a payable booking.
 */
export function decideRoomBookingEligibility(
  room: Record<string, any>,
  expectedOwnerId = '',
): RoomBookingDecision {
  const ownerId = String(room.ownerId || '').trim();
  if (expectedOwnerId && ownerId !== expectedOwnerId.trim()) {
    return { allowed: false, reason: 'owner-mismatch' };
  }

  const status = String(room.status || '').trim();
  if (
    room.isAvailable === false ||
    room.deletionInProgress === true ||
    status !== 'available'
  ) {
    return { allowed: false, reason: 'unavailable' };
  }

  if (!isValidMonthlyRent(room.monthlyRent)) {
    return { allowed: false, reason: 'invalid-rent' };
  }

  if (!isValidRoomCapacity(room.occupancy)) {
    return { allowed: false, reason: 'invalid-capacity' };
  }
  if (!isValidCurrentOccupancy(room.currentOccupancy)) {
    return { allowed: false, reason: 'invalid-occupancy' };
  }

  const capacity = readRoomCapacityState(room);
  if (!capacity) {
    return { allowed: false, reason: 'invalid-occupancy' };
  }
  if (capacity.currentOccupancy >= capacity.capacity) {
    return { allowed: false, reason: 'full' };
  }

  return { allowed: true, capacity };
}

/** The user-facing explanation for a rejected room-booking decision. */
export function roomBookingRejectionMessage(
  reason: RoomBookingRejection,
): string {
  switch (reason) {
    case 'owner-mismatch':
      return 'The room owner does not match this booking request.';
    case 'invalid-rent':
      return 'The rent for this room is not valid.';
    case 'invalid-capacity':
      return 'This room has an invalid capacity.';
    case 'invalid-occupancy':
      return 'This room has an invalid occupancy.';
    case 'full':
      return 'That room is full — every slot is taken.';
    case 'unavailable':
    default:
      return 'That room is not available';
  }
}
