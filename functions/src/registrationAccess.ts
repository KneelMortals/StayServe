/** The roles which may be selected during registration. */
export type RegistrationRole = 'student' | 'owner';

/**
 * The profile state which is allowed to finish or claim a registration.
 *
 * A profile may be completed only while it is explicitly **incomplete** and
 * still active. In particular, `registrationCompleted: true` is final: a
 * completed owner must not be able to call the registration callable again,
 * change their live role to `student`, and then use that role to book a room.
 */
export interface RegistrationProfileState {
  exists: boolean;
  registrationCompleted: unknown;
  isActive: unknown;
  /** Whether this role was already selected by a registration call. */
  roleClaimed: unknown;
  /** The role currently stored in the live profile. */
  role: unknown;
}

/**
 * Whether the profile may still take part in a registration call.
 *
 * A missing profile is accepted because the Auth trigger and the registration
 * callable can legitimately race each other. Existing profiles must carry the
 * explicit `registrationCompleted: false` marker and must still be active; a
 * missing marker is treated as an old/legacy profile and is not allowed to
 * claim a role again. The activation flag is fail-closed as well: an existing
 * profile whose `isActive` field is missing is not silently reactivated.
 */
export function canCompleteRegistration(
  profile: RegistrationProfileState,
): boolean {
  if (!profile.exists) return true;
  return (
    profile.registrationCompleted === false && profile.isActive === true
  );
}

/**
 * Whether the role has already been selected.
 *
 * `roleClaimed` is the server-owned marker written by `registerUserRole` and
 * `completeRegistration`. An existing owner/admin role is also treated as
 * claimed: older trigger-created profiles have no marker, but a role other
 * than the trigger's default `student` is evidence that the role was already
 * selected and must not be changed by another registration call.
 */
export function hasClaimedRegistrationRole(
  profile: RegistrationProfileState,
): boolean {
  if (!profile.exists) return false;
  if (profile.roleClaimed === true) return true;

  const role = String(profile.role ?? '').trim().toLowerCase();
  return role === 'owner' || role === 'admin';
}

/**
 * Whether this call may claim the role of an incomplete registration.
 *
 * The role claim is one-time. A user which already selected `owner` cannot
 * call the callable again and switch itself to `student` before the profile
 * is completed.
 */
export function canClaimRegistrationRole(
  profile: RegistrationProfileState,
): boolean {
  return (
    canCompleteRegistration(profile) &&
    !hasClaimedRegistrationRole(profile)
  );
}

/**
 * Resolves the role which the registration may store.
 *
 * A role which was already claimed is preserved. A new registration may
 * select either `student` or `owner`. `null` means that the profile already
 * contains a locked but invalid role and must be repaired by an administrator
 * instead of being silently overwritten.
 */
export function resolveRegistrationRole(
  profile: RegistrationProfileState,
  requestedRole: RegistrationRole,
): RegistrationRole | null {
  if (!profile.exists) return requestedRole;
  if (!hasClaimedRegistrationRole(profile)) return requestedRole;

  const existing = String(profile.role ?? '').trim().toLowerCase();
  if (existing === 'student' || existing === 'owner') {
    return existing;
  }
  return null;
}
