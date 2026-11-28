import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../../core/constants/enums.dart';
import '../../../../../firebase/owner/owner_repository.dart';
import '../../../../../models/join_request_model.dart';
import '../../../../../models/owned_room_model.dart';
import '../../../auth/presentation/providers/auth_provider.dart';

/// The signed-in account, or `null` while nobody is signed in.
///
/// Every owner-side list watches it: a listener which is attached while
/// Firebase Auth is switching the account is evaluated with the token of the
/// **previous** account, and the security rules refuse that read. Without the
/// watch the refused listener would keep its error state until the screen
/// was rebuilt by hand.
///
/// The **role** gate matters just as much: a student has no business in the
/// owner-side collections (`joinRequests`, `roomDrafts`, `commissionInvoices`
/// are owner-scoped), and the security rules refuse that read as well. The
/// listener is therefore never attached for an account which cannot read it.
/// An administrator may read every collection and is allowed through.
final ownerUidProvider = Provider<String?>((ref) {
  final session = ref.watch(authSessionProvider).valueOrNull;
  if (session == null) return null;

  // The role of the **live** profile: it fails closed while the profile is
  // still loading instead of briefly assuming the wrong role.
  final role = session.profile?.role;
  if (role != UserRole.owner && role != UserRole.admin) return null;

  return session.user.uid;
});

final myRoomsProvider = StreamProvider.autoDispose<List<OwnedRoomModel>>((ref) {
  final uid = ref.watch(ownerUidProvider);
  if (uid == null) return Stream.value([]);
  return ref.watch(ownerRepositoryProvider).watchMyRooms(uid);
});

/// The owner's rooms grouped by their home.
///
/// An owner often publishes more than one room in the same house; the
/// grouping lets the "My Rooms" screen show them together.
final ownerHomesProvider = Provider<List<OwnerHome>>((ref) {
  final rooms =
      ref.watch(myRoomsProvider).valueOrNull ?? const <OwnedRoomModel>[];
  return groupRoomsByHome(rooms);
});

final myJoinRequestsProvider =
    StreamProvider.autoDispose<List<JoinRequestModel>>((ref) {
      final uid = ref.watch(ownerUidProvider);
      if (uid == null) return Stream.value([]);
      return ref.watch(ownerRepositoryProvider).watchMyJoinRequests(uid);
    });

final myInvoicesProvider =
    StreamProvider.autoDispose<List<CommissionInvoiceModel>>((ref) {
      final uid = ref.watch(ownerUidProvider);
      if (uid == null) return Stream.value([]);
      return ref.watch(ownerRepositoryProvider).watchMyInvoices(uid);
    });

/// Aggregated counters for the owner dashboard.
final ownerStatsProvider = Provider<OwnerStats>((ref) {
  // `valueOrNull` and **not** `value`: `AsyncValue.value` re-throws the
  // error when there is no previous value, which turned every stream failure
  // into a crash of the whole owner dashboard instead of the graceful
  // "Could not load" screen.
  final rooms =
      ref.watch(myRoomsProvider).valueOrNull ?? const <OwnedRoomModel>[];
  final requests =
      ref.watch(myJoinRequestsProvider).valueOrNull ??
      const <JoinRequestModel>[];
  final invoices =
      ref.watch(myInvoicesProvider).valueOrNull ??
      const <CommissionInvoiceModel>[];

  return ref
      .watch(ownerRepositoryProvider)
      .getStats(rooms: rooms, requests: requests, invoices: invoices);
});
