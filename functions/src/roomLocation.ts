/**
 * Pure helpers for the public/private room-location split.
 *
 * The exact address and the exact coordinates of a room live in
 * `roomPrivate/{roomId}`. A public room document contains only coarse
 * locality data (and, during the compatibility stage, the legacy exact
 * fields which are removed by the final migration).
 *
 * This module deliberately has no Firebase imports. The migration and the
 * security tests can therefore exercise the field decisions without opening
 * a Firestore connection.
 */

/** The server-side stage of the room-location migration. */
export type RoomLocationStage = 'dual' | 'private';

/** The exact location of one room. */
export interface ExactRoomLocation {
  address: string;
  city: string;
  state: string;
  pincode: string;
  latitude: number | null;
  longitude: number | null;
}

/** The coarse location which may be stored in a public room document. */
export interface CoarseRoomLocation {
  city: string;
  state: string;
}

function cleanText(value: unknown, maxLength: number): string {
  return String(value ?? '').trim().slice(0, maxLength);
}

/** Reads a finite coordinate, or `null` for a missing/invalid value. */
export function roomCoordinate(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Parses the server-controlled migration stage.
 *
 * `dual` is the safe compatibility default: the private document and the
 * legacy public fields are both written. `private` is enabled only after
 * every listing has a verified private counterpart.
 */
export function roomLocationStage(value: unknown): RoomLocationStage {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === '' || normalized === 'dual') return 'dual';
  if (normalized === 'private') return 'private';

  throw new Error(
    `Invalid ROOM_LOCATION_STAGE value "${normalized}". Expected "dual" or "private".`,
  );
}

/** The stage configured for the current function process. */
export function configuredRoomLocationStage(): RoomLocationStage {
  return roomLocationStage(process.env.ROOM_LOCATION_STAGE);
}

/**
 * Rounds a coordinate to the public geocell precision.
 *
 * Two decimal places are roughly one kilometre. The rounded value is only a
 * distance hint; it is not the address of the room.
 */
export function coarseRoomCoordinate(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;

  // Round the magnitude away from zero at an exact half-cent boundary.
  // The tiny epsilon compensates for binary floating-point representations
  // such as `1.005 * 100 === 100.49999999999999`. The Dart client uses the
  // same rule so both platforms publish the same geocell.
  const magnitude = Math.abs(value);
  const scaled = magnitude * 100;
  const rounded = (Math.floor(scaled + 0.5 + 1e-9) / 100) * Math.sign(value);
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** The public geocell for an exact coordinate pair. */
export function roomGeoCell(location: {
  latitude: number | null;
  longitude: number | null;
}): string | null {
  const latitude = coarseRoomCoordinate(location.latitude);
  const longitude = coarseRoomCoordinate(location.longitude);
  if (latitude === null || longitude === null) return null;
  return `${latitude.toFixed(2)},${longitude.toFixed(2)}`;
}

/** The city/state which may be published in the public room document. */
export function coarsePublicRoomLocation(
  location: Pick<ExactRoomLocation, 'city' | 'state'>,
): CoarseRoomLocation {
  return {
    city: cleanText(location.city, 128),
    state: cleanText(location.state, 128),
  };
}

/**
 * Reads the exact location from a legacy/public room document.
 *
 * Both the nested `location` map and the old flat fields are accepted. The
 * function is used by the migration and by the temporary dual-stage visit
 * fallback; new writes never put these values in a public document.
 */
export function readExactPublicRoomLocation(
  room: Record<string, any>,
): ExactRoomLocation {
  const nested =
    room.location && typeof room.location === 'object'
      ? (room.location as Record<string, any>)
      : {};

  const nestedLatitude = roomCoordinate(nested.latitude);
  const nestedLongitude = roomCoordinate(nested.longitude);
  const flatLatitude = roomCoordinate(room.latitude);
  const flatLongitude = roomCoordinate(room.longitude);

  const latitude =
    nestedLatitude !== null
      ? nestedLatitude
      : flatLatitude !== null
        ? flatLatitude
        : null;
  const longitude =
    nestedLongitude !== null
      ? nestedLongitude
      : flatLongitude !== null
        ? flatLongitude
        : null;

  return {
    address: cleanText(nested.address || room.address, 512),
    city: cleanText(nested.city || room.city, 128),
    state: cleanText(nested.state || room.state, 128),
    pincode: cleanText(nested.pincode || room.pincode, 32),
    latitude,
    longitude,
  };
}

/** Normalizes an owner-supplied exact location. */
export function normalizeExactRoomLocation(
  value: Record<string, any>,
): ExactRoomLocation {
  return {
    address: cleanText(value.address, 512),
    city: cleanText(value.city, 128),
    state: cleanText(value.state, 128),
    pincode: cleanText(value.pincode, 32),
    latitude: roomCoordinate(value.latitude),
    longitude: roomCoordinate(value.longitude),
  };
}

/** Whether an exact location contains every value required by the app. */
export function hasCompleteExactRoomLocation(
  location: ExactRoomLocation,
): boolean {
  const hasCoordinatePair =
    (location.latitude === null && location.longitude === null) ||
    (location.latitude !== null &&
      location.longitude !== null &&
      location.latitude >= -90 &&
      location.latitude <= 90 &&
      location.longitude >= -180 &&
      location.longitude <= 180);

  return (
    location.address.length > 0 &&
    location.city.length > 0 &&
    location.state.length > 0 &&
    location.pincode.length > 0 &&
    hasCoordinatePair
  );
}

/** Whether two exact locations contain the same normalized values. */
export function exactRoomLocationsMatch(
  left: ExactRoomLocation,
  right: ExactRoomLocation,
): boolean {
  return (
    left.address === right.address &&
    left.city === right.city &&
    left.state === right.state &&
    left.pincode === right.pincode &&
    left.latitude === right.latitude &&
    left.longitude === right.longitude
  );
}

/**
 * Whether a public room document still contains an exact address or exact
 * coordinate.
 *
 * `geoCell` is deliberately not exact: it is the rounded, public distance
 * hint and is allowed to remain after the final migration.
 */
export function publicRoomHasExactLocation(room: Record<string, any>): boolean {
  if (
    room.address !== undefined ||
    room.pincode !== undefined ||
    room.latitude !== undefined ||
    room.longitude !== undefined
  ) {
    return true;
  }

  const nested =
    room.location && typeof room.location === 'object'
      ? (room.location as Record<string, any>)
      : {};

  return (
    nested.address !== undefined ||
    nested.pincode !== undefined ||
    nested.latitude !== undefined ||
    nested.longitude !== undefined
  );
}
