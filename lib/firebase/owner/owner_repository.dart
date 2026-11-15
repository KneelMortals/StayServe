import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';
import 'package:uuid/uuid.dart';

import '../../../core/constants/enums.dart';
import '../../../core/utils/app_logger.dart';
import '../../../models/join_request_model.dart';
import '../../../models/room_model.dart';
import '../auth/auth_service.dart';
import '../functions/functions_service.dart';
import '../storage/storage_service.dart';

final ownerRepositoryProvider = Provider<OwnerRepository>((ref) {
  return OwnerRepository(
    firestore: ref.watch(firestoreProvider),
    auth: ref.watch(firebaseAuthProvider),
    functions: ref.watch(functionsServiceProvider),
    storage: ref.watch(storageServiceProvider),
  );
});

/// Data access for the room owner side of the app.
class OwnerRepository {
  final FirebaseFirestore _firestore;
  final FirebaseAuth _auth;
  final FunctionsService _functions;
  final StorageService _storage;

  static const Uuid _uuid = Uuid();

  OwnerRepository({
    required this._firestore,
    required this._auth,
    required this._functions,
    required this._storage,
  });

  String? get _uid => _auth.currentUser?.uid;

  /// Rooms listed by the current owner.
  Stream<List<RoomModel>> watchMyRooms() {
    final uid = _uid;
    if (uid == null) return Stream.value([]);

    return _firestore
        .collection('rooms')
        .where('ownerId', isEqualTo: uid)
        .orderBy('createdAt', descending: true)
        .snapshots()
        .map(
          (snapshot) => snapshot.docs
              .map((doc) {
                // One malformed listing must not break the whole list.
                try {
                  return RoomModel.fromJson(doc.data());
                } catch (_) {
                  return null;
                }
              })
              .whereType<RoomModel>()
              .toList(),
        );
  }

  /// Join requests addressed to the current owner's rooms.
  Stream<List<JoinRequestModel>> watchMyJoinRequests() {
    final uid = _uid;
    if (uid == null) return Stream.value([]);

    return _firestore
        .collection('joinRequests')
        .where('ownerId', isEqualTo: uid)
        .orderBy('createdAt', descending: true)
        .snapshots()
        .map(
          (snapshot) => snapshot.docs
              .map((doc) => JoinRequestModel.fromJson(doc.data()))
              .toList(),
        );
  }

  /// Commission invoices raised against the current owner's rooms.
  Stream<List<CommissionInvoiceModel>> watchMyInvoices() {
    final uid = _uid;
    if (uid == null) return Stream.value([]);

    return _firestore
        .collection('commissionInvoices')
        .where('ownerId', isEqualTo: uid)
        .orderBy('createdAt', descending: true)
        .snapshots()
        .map(
          (snapshot) => snapshot.docs
              .map((doc) => CommissionInvoiceModel.fromJson(doc.data()))
              .toList(),
        );
  }

  /// Creates a room listing.
  ///
  /// The photos the owner picked are uploaded to Firebase Storage first;
  /// the listing is only written once all of them made it. A listing
  /// without any photo is still created — the photos are optional.
  Future<String> createRoom(RoomDraft draft) async {
    final uid = _uid;
    if (uid == null) throw Exception('User not logged in');

    // The Firestore rules only accept a positive capacity. Checking it here
    // turns a permission error into a message the owner understands.
    if (draft.room.occupancy <= 0) {
      throw Exception(
        'The number of people who can live in the room must be at least 1',
      );
    }

    final roomId = 'RM-${_uuid.v4()}';

    final imageUrls = await _uploadImages(roomId, draft);

    final document = draft.room.copyWith(
      roomId: roomId,
      ownerId: uid,
      images: imageUrls,
      createdAt: draft.room.createdAt,
      updatedAt: DateTime.now(),
      // A new listing always starts on the market and without any tenants.
      // Both fields are server-owned from the moment the listing exists
      // (the Firestore rules accept only these initial values), so they are
      // stated here instead of being left out — a listing without a status
      // is invisible to the student search, because a Firestore equality
      // query never matches a document that does not have the field.
      status: RoomStatus.available,
      currentOccupancy: 0,
    );

    await _firestore
        .collection('rooms')
        .doc(roomId)
        .set(document.toCreateJson());
    return roomId;
  }

  /// Updates one of the current owner's rooms.
  Future<void> updateRoom(RoomDraft draft) async {
    final uid = _uid;
    if (uid == null) throw Exception('User not logged in');

    final roomRef = _firestore.collection('rooms').doc(draft.room.roomId);
    final snapshot = await roomRef.get();
    if (!snapshot.exists) throw Exception('Room not found');
    final data = snapshot.data();
    if (data?['ownerId'] != uid) {
      throw Exception('You can only edit your own listings');
    }

    // The tenant counter is server-owned: it is raised by the booking
    // activation and lowered by the rollback. The capacity therefore may
    // never be smaller than the number of people who already live there —
    // the Firestore rules refuse the write, this check explains it.
    final currentOccupancy = (data?['currentOccupancy'] as num?)?.toInt() ?? 0;
    if (draft.room.occupancy <= 0) {
      throw Exception(
        'The number of people who can live in the room must be at least 1',
      );
    }
    if (draft.room.occupancy < currentOccupancy) {
      throw Exception(
        'This room already has $currentOccupancy '
        '${currentOccupancy == 1 ? 'person' : 'people'} living in it, so the '
        'capacity cannot be lower than $currentOccupancy.',
      );
    }

    final imageUrls = await _uploadImages(draft.room.roomId, draft);

    // The photos the owner removed are deleted from the storage as well,
    // so they do not pile up forever.
    final removed = draft.room.images
        .where((url) => !imageUrls.contains(url))
        .toList();
    if (removed.isNotEmpty) {
      try {
        await _storage.deleteFiles(removed);
      } catch (e) {
        AppLogger.warning('Could not delete the removed photos', error: e);
      }
    }

    final document = draft.room.copyWith(
      images: imageUrls,
      updatedAt: DateTime.now(),
    );

    // Only the owner-editable fields are written. A full-document `set`
    // would send the stale `status` / `currentOccupancy` values back and
    // could overwrite a change the server made in the meantime.
    await roomRef.update(document.toOwnerUpdateJson());
  }

  /// Uploads the newly picked photos and returns the complete photo list.
  ///
  /// The photos are stored under `rooms/{ownerUid}/{roomId}/…`. The uid of
  /// the owner is part of the path on purpose: the Firebase Storage rules
  /// check it, so a signed-in user can only ever write below their own
  /// folder — nobody can upload into the folder of another owner.
  Future<List<String>> _uploadImages(String roomId, RoomDraft draft) async {
    final urls = <String>[...draft.room.images];
    final uid = _uid;
    if (uid == null) throw Exception('User not logged in');

    for (final image in draft.newImages) {
      try {
        final bytes = await _readBytes(image);
        if (bytes == null) continue;

        final fileName =
            '${DateTime.now().millisecondsSinceEpoch}'
            '_${_uuid.v4().substring(0, 8)}.jpg';
        final url = await _storage.uploadImage(
          path: 'rooms/$uid/$roomId',
          fileName: fileName,
          bytes: bytes,
        );
        urls.add(url);
      } catch (e) {
        AppLogger.warning('Could not upload a room photo', error: e);
        rethrow;
      }
    }

    return urls;
  }

  /// Reads the bytes of a picked image.
  Future<List<int>?> _readBytes(XFile file) async {
    try {
      return await file.readAsBytes();
    } catch (e) {
      AppLogger.warning('Could not read a picked photo', error: e);
      return null;
    }
  }

  /// Marks a room's listing as occupied (or available again).
  ///
  /// The server verifies that the signed-in user is a live owner of this
  /// listing and updates only the listing status. The occupancy counter is
  /// server-owned: it is maintained by booking activation and is never
  /// changed by this action.
  Future<void> setRoomOccupied(String roomId, {required bool occupied}) async {
    final uid = _uid;
    if (uid == null) throw Exception('User not logged in');

    await _functions.callVoidFunction(
      'setRoomListingAvailability',
      parameters: {'roomId': roomId, 'isOccupied': occupied},
      fallbackMessage: 'Could not change the listing status',
    );
  }

  /// Deletes one of the current owner's empty rooms.
  ///
  /// The server performs the deletion so it can refuse a room that has an
  /// active booking or a payment waiting for verification. It also cancels
  /// the open requests in the same operation and notifies their students.
  Future<void> deleteRoom(String roomId) async {
    final uid = _uid;
    if (uid == null) throw Exception('User not logged in');

    // Read the image list before the room is removed. The server still owns
    // and verifies the actual deletion.
    final roomRef = _firestore.collection('rooms').doc(roomId);
    final snapshot = await roomRef.get();
    if (!snapshot.exists) return;

    await _functions.callVoidFunction(
      'deleteRoomListing',
      parameters: {'roomId': roomId},
      fallbackMessage: 'Could not delete the room',
    );

    // The photos of the room are removed from the storage as well.
    final images =
        (snapshot.data()?['images'] as List<dynamic>?)
            ?.whereType<String>()
            .toList() ??
        const <String>[];
    if (images.isNotEmpty) {
      try {
        await _storage.deleteFiles(images);
      } catch (e) {
        AppLogger.warning('Could not delete the photos of the room', error: e);
      }
    }
  }

  /// Approves a join request (owner confirmation step).
  ///
  /// The status change and the notification are done by the server, which
  /// checks that the caller really is the owner of the request.
  Future<void> confirmRequest(String requestId) async {
    final uid = _uid;
    if (uid == null) throw Exception('User not logged in');

    await _functions.callFunction(
      'respondToJoinRequest',
      parameters: {'requestId': requestId, 'approve': true},
    );
  }

  /// Rejects a join request.
  Future<void> rejectRequest(String requestId, {String? reason}) async {
    final uid = _uid;
    if (uid == null) throw Exception('User not logged in');

    await _functions.callFunction(
      'respondToJoinRequest',
      parameters: {
        'requestId': requestId,
        'approve': false,
        if (reason != null && reason.trim().isNotEmpty) 'reason': reason.trim(),
      },
    );
  }

  /// Cancels a booking request of the owner.
  ///
  /// The owner may walk away from a request **after** they approved it —
  /// as long as nothing was paid for it yet. The server checks that, so the
  /// app cannot cancel a booking that already has money in it.
  Future<void> cancelRequest(String requestId, {String? reason}) async {
    final uid = _uid;
    if (uid == null) throw Exception('User not logged in');

    await _functions.callFunction(
      'cancelJoinRequest',
      parameters: {
        'requestId': requestId,
        if (reason != null && reason.trim().isNotEmpty) 'reason': reason.trim(),
      },
    );
  }

  /// Counts used by the owner dashboard.
  OwnerStats getStats({
    required List<RoomModel> rooms,
    required List<JoinRequestModel> requests,
    required List<CommissionInvoiceModel> invoices,
  }) {
    final pending = requests
        .where((r) => r.status == JoinRequestStatus.pending)
        .length;
    // A payment may only be submitted after the student has confirmed the
    // owner's acceptance. `ownerConfirmed` is still waiting for the student,
    // so it is not an outstanding platform-fee payment.
    final approved = requests
        .where(
          (r) =>
              r.status == JoinRequestStatus.studentConfirmed &&
              !r.advancePaid &&
              r.advancePaymentStatus != PaymentStatus.submitted,
        )
        .length;
    final revenue = invoices
        .where((i) => i.status == InvoiceStatus.paid)
        .fold<double>(0, (total, invoice) => total + invoice.commissionAmount);

    return OwnerStats(
      totalRooms: rooms.length,
      availableRooms: rooms.where((r) => r.isAvailable).length,
      occupiedRooms: rooms.where((r) => r.isOccupied).length,
      pendingRequests: pending,
      awaitingPayment: approved,
      totalRevenue: revenue,
      totalHomes: groupRoomsByHome(rooms).length,
    );
  }
}

/// A home (building / property) with all the rooms the owner published in it.
class OwnerHome {
  final String id;
  final String name;
  final String address;
  final List<RoomModel> rooms;

  const OwnerHome({
    required this.id,
    required this.name,
    required this.address,
    required this.rooms,
  });

  int get roomCount => rooms.length;
  int get availableCount => rooms.where((r) => r.isAvailable).length;
  int get occupiedCount => rooms.where((r) => r.isOccupied).length;
}

/// Groups the owner's rooms by their home.
///
/// The rooms that were published before the "homes" feature existed do not
/// have a home id — they are collected under a single "Other listings" group
/// so that they never disappear from the list.
List<OwnerHome> groupRoomsByHome(List<RoomModel> rooms) {
  final grouped = <String, List<RoomModel>>{};
  for (final room in rooms) {
    grouped.putIfAbsent(room.resolvedHomeId, () => []).add(room);
  }

  final homes = grouped.entries.map((entry) {
    final roomsInHome = entry.value;
    final first = roomsInHome.first;
    final address = roomsInHome
        .map((r) => r.location.address)
        .firstWhere(
          (a) => a.trim().isNotEmpty,
          orElse: () => first.location.shortAddress,
        );

    return OwnerHome(
      id: entry.key,
      name: first.resolvedHomeName,
      address: address,
      rooms: roomsInHome,
    );
  }).toList();

  homes.sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));
  return homes;
}

/// The listing as it comes out of the form.
///
/// It carries the photos that still have to be uploaded separately, because
/// they only exist on the device until the listing is saved.
class RoomDraft {
  final RoomModel room;
  final List<XFile> newImages;

  const RoomDraft({required this.room, this.newImages = const []});
}

/// Aggregated numbers shown on the owner dashboard.
class OwnerStats {
  final int totalRooms;
  final int availableRooms;
  final int occupiedRooms;
  final int pendingRequests;
  final int awaitingPayment;
  final double totalRevenue;

  /// The number of homes (properties) the owner publishes rooms in.
  final int totalHomes;

  const OwnerStats({
    required this.totalRooms,
    required this.availableRooms,
    required this.occupiedRooms,
    required this.pendingRequests,
    required this.awaitingPayment,
    required this.totalRevenue,
    this.totalHomes = 0,
  });
}
