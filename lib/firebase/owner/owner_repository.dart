import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';
import 'package:uuid/uuid.dart';

import '../../../core/constants/app_constants.dart';
import '../../../core/constants/enums.dart';
import '../../../core/utils/app_logger.dart';
import '../../../core/utils/safe_document_parser.dart';
import '../../../models/join_request_model.dart';
import '../../../models/owned_room_model.dart';
import '../../../models/room_model.dart';
import '../../../models/room_private_location.dart';
import '../auth/auth_service.dart';
import '../functions/functions_service.dart';
import '../storage/storage_service.dart';
import 'room_image_reconciliation.dart';

final ownerRepositoryProvider = Provider<OwnerRepository>((ref) {
  return OwnerRepository(
    firestore: ref.watch(firestoreProvider),
    auth: ref.watch(firebaseAuthProvider),
    functions: ref.watch(functionsServiceProvider),
    storage: ref.watch(storageServiceProvider),
  );
});

/// The files uploaded for one room edit.
///
/// The object paths are tracked in addition to the download URLs because an
/// upload can succeed while fetching its download URL fails. In that case
/// there is no URL to delete, but the object path is still known.
class _RoomImageUpload {
  final List<String> newlyUploadedUrls;
  final List<String> newlyUploadedPaths;

  const _RoomImageUpload({
    required this.newlyUploadedUrls,
    required this.newlyUploadedPaths,
  });
}

/// Reads a room-photo list without trusting its Firestore shape.
List<String> _safeImageUrls(dynamic value) {
  if (value is! List) return const <String>[];
  final urls = <String>[];
  for (final item in value) {
    if (item is! String) continue;
    final url = item.trim();
    if (url.isEmpty || urls.contains(url)) continue;
    urls.add(url);
  }
  return urls;
}

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
  ///
  /// The public listing contains only coarse location data after the privacy
  /// migration. The owner view joins the server-owned private location back
  /// in so the edit form can still show and change the exact address.
  Stream<List<OwnedRoomModel>> watchMyRooms() {
    final uid = _uid;
    if (uid == null) return Stream.value([]);

    return _firestore
        .collection('rooms')
        .where('ownerId', isEqualTo: uid)
        .orderBy('createdAt', descending: true)
        .snapshots()
        .asyncMap((snapshot) async {
          final rooms = <OwnedRoomModel>[];
          for (final doc in snapshot.docs) {
            RoomModel listing;
            try {
              listing = RoomModel.fromJson(doc.data(), documentId: doc.id);
            } catch (_) {
              // One malformed listing must not break the whole list.
              continue;
            }

            RoomPrivateLocation? privateLocation;
            try {
              final privateSnapshot = await _firestore
                  .collection('roomPrivate')
                  .doc(doc.id)
                  .get();
              if (privateSnapshot.exists) {
                final candidate = RoomPrivateLocation.fromJson(
                  privateSnapshot.data() ?? const <String, dynamic>{},
                );
                if (candidate.roomId == doc.id && candidate.ownerId == uid) {
                  privateLocation = candidate;
                }
              }
            } catch (error) {
              // A missing private document is a normal state during the
              // staged migration. Some older deployed rule versions deny
              // that read; the owner-facing legacy fallback keeps the edit
              // form usable until the compatible rules are deployed.
              AppLogger.warning(
                'Could not read the private room location for ${doc.id}',
                error: error,
              );
            }

            // Only the owner-facing view reads the legacy exact fields, and
            // it keeps them in the private-location model. The public room
            // model continues to expose coarse data only.
            privateLocation ??= RoomPrivateLocation.fromLegacyRoomJson(
              doc.data(),
              roomId: doc.id,
              ownerId: uid,
            );

            rooms.add(
              OwnedRoomModel(
                listing: listing,
                privateLocation: privateLocation,
              ),
            );
          }
          return rooms;
        });
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
          (snapshot) => parseDocumentsSafely(
            snapshot.docs.map((doc) => (id: doc.id, data: doc.data())),
            (_, data) => JoinRequestModel.fromJson(data),
            onError: (id, error) => AppLogger.warning(
              'Could not read the owner join request $id',
              error: error,
            ),
          ),
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
          (snapshot) => parseDocumentsSafely(
            snapshot.docs.map((doc) => (id: doc.id, data: doc.data())),
            (_, data) => CommissionInvoiceModel.fromJson(data),
            onError: (id, error) => AppLogger.warning(
              'Could not read the commission invoice $id',
              error: error,
            ),
          ),
        );
  }

  /// Writes the exact location to the server-owned private collection.
  ///
  /// The callable verifies the live owner and updates the private document
  /// and the public compatibility fields in one transaction.
  Future<void> _writePrivateLocation(
    String roomId,
    RoomPrivateLocation location,
  ) async {
    await _functions.callVoidFunction(
      'setRoomPrivateLocation',
      parameters: {'roomId': roomId, ...location.toCallablePayload()},
      fallbackMessage: 'Could not save the private room location',
    );
  }

  RoomPrivateLocation _draftPrivateLocation(
    RoomDraft draft, {
    required String roomId,
    required String ownerId,
  }) {
    final location = draft.privateLocation;
    return RoomPrivateLocation(
      roomId: roomId,
      ownerId: ownerId,
      address: location.address,
      city: location.city,
      state: location.state,
      pincode: location.pincode,
      latitude: location.latitude,
      longitude: location.longitude,
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

    // The Firestore rules enforce the same range. Checking it here turns a
    // permission error into a message the owner understands.
    if (draft.room.occupancy < 1 || draft.room.occupancy > 20) {
      throw Exception(
        'The number of people who can live in the room must be between 1 and 20',
      );
    }
    if (!draft.room.monthlyRent.isFinite ||
        draft.room.monthlyRent < 1000 ||
        draft.room.monthlyRent > 1000000) {
      throw Exception('The monthly rent must be between ₹1,000 and ₹10,00,000');
    }

    final roomId = 'RM-${_uuid.v4()}';

    final upload = await _uploadImages(roomId, draft);
    final imageUrls = upload.newlyUploadedUrls;

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

    var listingRemoved = false;
    try {
      // The public document starts with coarse locality data only. The
      // owner-only callable then stores the exact location privately and,
      // during the compatibility stage, keeps the legacy public fields in
      // the same transaction.
      await _firestore
          .collection('rooms')
          .doc(roomId)
          .set(document.toCreateJson());

      try {
        await _writePrivateLocation(
          roomId,
          _draftPrivateLocation(draft, roomId: roomId, ownerId: uid),
        );
      } catch (error) {
        // A listing without its private counterpart is not a complete
        // listing. Remove it through the server so the photos and the
        // request history are cleaned up consistently.
        try {
          await _functions.callVoidFunction(
            'deleteRoomListing',
            parameters: {'roomId': roomId},
            fallbackMessage: 'Could not remove the incomplete listing',
          );
          listingRemoved = true;
        } catch (_) {
          await _rollbackNewUploadsIfUnreferenced(
            _firestore.collection('rooms').doc(roomId),
            upload,
          );
        }
        rethrow;
      }
    } catch (error) {
      // A network failure does not prove that the write was not committed.
      // Reconcile with the room document before deleting an uploaded object:
      // a committed listing must never be left pointing at deleted photos.
      if (!listingRemoved) {
        await _rollbackNewUploadsIfUnreferenced(
          _firestore.collection('rooms').doc(roomId),
          upload,
        );
      }
      rethrow;
    }
    return roomId;
  }

  /// Updates one of the current owner's rooms.
  Future<void> updateRoom(RoomDraft draft) async {
    final uid = _uid;
    if (uid == null) throw Exception('User not logged in');

    final roomRef = _firestore.collection('rooms').doc(draft.room.roomId);
    final upload = await _uploadImages(draft.room.roomId, draft);
    final document = draft.room.copyWith(updatedAt: DateTime.now());

    try {
      // The exact location is written first. The server stores it privately
      // and updates the public compatibility fields in the same transaction,
      // so a failed photo/listing update can never split the address across
      // two different values.
      await _writePrivateLocation(
        draft.room.roomId,
        _draftPrivateLocation(draft, roomId: draft.room.roomId, ownerId: uid),
      );

      // The image list and the other owner-editable fields are committed in
      // one transaction. The transaction re-reads the live room, so a photo
      // added by another device while this form was open is preserved and a
      // photo which another edit already removed is never restored.
      await _firestore.runTransaction((transaction) async {
        final snapshot = await transaction.get(roomRef);
        if (!snapshot.exists) throw Exception('Room not found');

        final data = snapshot.data();
        if (data?['ownerId'] != uid) {
          throw Exception('You can only edit your own listings');
        }

        // The tenant counter is server-owned: it is raised by the booking
        // activation and lowered by the rollback. The capacity therefore may
        // never be smaller than the number of people who already live there.
        final currentOccupancy =
            (data?['currentOccupancy'] as num?)?.toInt() ?? 0;
        if (draft.room.occupancy < 1 || draft.room.occupancy > 20) {
          throw Exception(
            'The number of people who can live in the room must be between 1 and 20',
          );
        }
        if (!draft.room.monthlyRent.isFinite ||
            draft.room.monthlyRent < 1000 ||
            draft.room.monthlyRent > 1000000) {
          throw Exception(
            'The monthly rent must be between ₹1,000 and ₹10,00,000',
          );
        }
        if (draft.room.occupancy < currentOccupancy) {
          throw Exception(
            'This room already has $currentOccupancy '
            '${currentOccupancy == 1 ? 'person' : 'people'} living in it, so '
            'the capacity cannot be lower than $currentOccupancy.',
          );
        }

        final result = reconcileRoomImages(
          currentImages: _safeImageUrls(data?['images']),
          originalImages: draft.originalImageUrls,
          draftImages: draft.room.images,
          uploadedImages: upload.newlyUploadedUrls,
        );
        if (result.images.length > AppConstants.maxImagesPerRoom) {
          throw Exception(
            'A room can have at most '
            '${AppConstants.maxImagesPerRoom} photos.',
          );
        }

        final payload = document.toOwnerUpdateJson()
          ..['images'] = result.images;
        transaction.update(roomRef, payload);
      });
    } catch (error) {
      // The acknowledgement may have been lost after Firestore committed the
      // transaction. Reconcile before deleting any newly uploaded object.
      await _rollbackNewUploadsIfUnreferenced(roomRef, upload);
      rethrow;
    }

    // The Firestore room-update trigger compares the committed image list
    // with the previous one and writes a durable server-side Storage-cleanup
    // job for every removed photo. The client deliberately does not delete
    // those objects: a stale client snapshot must never remove a photo which
    // a newer edit still references.
  }

  /// Uploads the newly picked photos and returns the complete photo list.
  ///
  /// The photos are stored under `rooms/{ownerUid}/{roomId}/…`. The uid of
  /// the owner is part of the path on purpose: the Firebase Storage rules
  /// check it, so a signed-in user can only ever write below their own
  /// folder — nobody can upload into the folder of another owner.
  Future<_RoomImageUpload> _uploadImages(String roomId, RoomDraft draft) async {
    final newlyUploadedUrls = <String>[];
    final newlyUploadedPaths = <String>[];
    final uid = _uid;
    if (uid == null) throw Exception('User not logged in');

    try {
      for (final image in draft.newImages) {
        final bytes = await _readBytes(image);
        if (bytes == null) {
          throw Exception('Could not read one of the selected room photos.');
        }

        if (bytes.isEmpty) {
          throw Exception(
            'This photo is still loading. Please wait a moment and try again.',
          );
        }
        if (bytes.length > AppConstants.maxImageSize) {
          throw Exception(
            'Each room photo must be smaller than '
            '${(AppConstants.maxImageSize / (1024 * 1024)).round()} MB.',
          );
        }

        final fileName =
            '${DateTime.now().millisecondsSinceEpoch}'
            '_${_uuid.v4().substring(0, 8)}.jpg';
        final objectPath = 'rooms/$uid/$roomId/$fileName';

        // Track the path before starting the upload. The object may be
        // created even when fetching its download URL fails afterwards.
        newlyUploadedPaths.add(objectPath);
        final url = await _storage.uploadImage(
          path: 'rooms/$uid/$roomId',
          fileName: fileName,
          bytes: bytes,
        );
        newlyUploadedUrls.add(url);
      }
    } catch (error) {
      // A later upload may fail after earlier files were uploaded. Roll the
      // partial upload back so the room never keeps orphaned objects.
      await _deletePathsBestEffort(newlyUploadedPaths);
      AppLogger.warning('Could not upload a room photo', error: error);
      rethrow;
    }

    return _RoomImageUpload(
      newlyUploadedUrls: newlyUploadedUrls,
      newlyUploadedPaths: newlyUploadedPaths,
    );
  }

  /// Deletes uploaded objects by their known Storage paths.
  Future<void> _deletePathsBestEffort(List<String> paths) async {
    if (paths.isEmpty) return;
    final failed = await _storage.deleteFilesAtPaths(paths);
    if (failed.isNotEmpty) {
      AppLogger.warning(
        'Could not delete ${failed.length} uploaded room photo object(s)',
        error: failed,
      );
    }
  }

  /// Removes newly uploaded objects only when the room does not reference
  /// them.
  ///
  /// A failed Firestore acknowledgement is ambiguous: the write may have been
  /// committed even though the client saw an error. Deleting the files in
  /// that case would leave a committed listing pointing at missing photos.
  /// When the follow-up read itself fails, the objects are kept because a
  /// missing photo is worse than a temporarily unreferenced object.
  Future<void> _rollbackNewUploadsIfUnreferenced(
    DocumentReference<Map<String, dynamic>> roomRef,
    _RoomImageUpload upload,
  ) async {
    if (upload.newlyUploadedPaths.isEmpty) return;

    final Set<String> referencedUrls;
    try {
      final snapshot = await roomRef.get();
      final currentImages = snapshot.exists
          ? _safeImageUrls(snapshot.data()?['images'])
          : const <String>[];
      referencedUrls = currentImages.toSet();
    } catch (error) {
      AppLogger.warning(
        'Could not verify a failed room edit; uploaded photos were kept',
        error: error,
      );
      return;
    }

    final unreferencedPaths = <String>[];
    for (var index = 0; index < upload.newlyUploadedPaths.length; index++) {
      final url = index < upload.newlyUploadedUrls.length
          ? upload.newlyUploadedUrls[index]
          : null;
      if (url == null || !referencedUrls.contains(url)) {
        unreferencedPaths.add(upload.newlyUploadedPaths[index]);
      }
    }
    await _deletePathsBestEffort(unreferencedPaths);
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
  /// listing. Making an occupied room available is an explicit release
  /// operation: the server ends its active bookings, clears the occupancy
  /// and removes those students from the room immediately.
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

    // The server owns the whole deletion. It removes the Firestore listing
    // and writes a durable Storage-cleanup job in the same transaction, so
    // the photos cannot be orphaned when the initiating client goes away.
    await _functions.callVoidFunction(
      'deleteRoomListing',
      parameters: {'roomId': roomId},
      fallbackMessage: 'Could not delete the room',
    );
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
    required Iterable<OwnedRoomModel> rooms,
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
  final List<OwnedRoomModel> rooms;

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
List<OwnerHome> groupRoomsByHome(Iterable<OwnedRoomModel> rooms) {
  final grouped = <String, List<OwnedRoomModel>>{};
  for (final room in rooms) {
    grouped.putIfAbsent(room.resolvedHomeId, () => []).add(room);
  }

  final homes = grouped.entries.map((entry) {
    final roomsInHome = entry.value;
    final first = roomsInHome.first;
    final address = roomsInHome
        .map((r) => r.privateLocation?.address ?? '')
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

  /// The exact location stored in the private collection.
  ///
  /// It is separate from the public room payload. The server writes it
  /// through the owner-only location callable.
  final RoomPrivateLocation privateLocation;

  /// The photos which were on the listing when the form was opened.
  ///
  /// The difference between this list and [RoomModel.images] tells the
  /// repository which photos the owner explicitly removed. It also lets a
  /// concurrent edit preserve a photo which was added after this form was
  /// opened.
  final List<String> originalImageUrls;

  const RoomDraft({
    required this.room,
    required this.privateLocation,
    this.newImages = const [],
    this.originalImageUrls = const [],
  });
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
