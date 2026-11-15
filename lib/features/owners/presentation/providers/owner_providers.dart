import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../../firebase/owner/owner_repository.dart';
import '../../../../../models/join_request_model.dart';
import '../../../../../models/room_model.dart';

final myRoomsProvider = StreamProvider.autoDispose<List<RoomModel>>((ref) {
  return ref.watch(ownerRepositoryProvider).watchMyRooms();
});

/// The owner's rooms grouped by their home.
///
/// An owner often publishes more than one room in the same house; the
/// grouping lets the "My Rooms" screen show them together.
final ownerHomesProvider = Provider<List<OwnerHome>>((ref) {
  final rooms = ref.watch(myRoomsProvider).valueOrNull ?? const <RoomModel>[];
  return groupRoomsByHome(rooms);
});

final myJoinRequestsProvider = StreamProvider.autoDispose<List<JoinRequestModel>>((ref) {
  return ref.watch(ownerRepositoryProvider).watchMyJoinRequests();
});

final myInvoicesProvider = StreamProvider.autoDispose<List<CommissionInvoiceModel>>((ref) {
  return ref.watch(ownerRepositoryProvider).watchMyInvoices();
});

/// Aggregated counters for the owner dashboard.
final ownerStatsProvider = Provider<OwnerStats>((ref) {
  // `valueOrNull` and **not** `value`: `AsyncValue.value` re-throws the
  // error when there is no previous value, which turned every stream failure
  // into a crash of the whole owner dashboard instead of the graceful
  // "Could not load" screen.
  final rooms = ref.watch(myRoomsProvider).valueOrNull ?? const <RoomModel>[];
  final requests =
      ref.watch(myJoinRequestsProvider).valueOrNull ?? const <JoinRequestModel>[];
  final invoices = ref.watch(myInvoicesProvider).valueOrNull ??
      const <CommissionInvoiceModel>[];

  return ref.watch(ownerRepositoryProvider).getStats(
        rooms: rooms,
        requests: requests,
        invoices: invoices,
      );
});
