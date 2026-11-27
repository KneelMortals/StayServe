import 'dart:convert';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';
import 'package:uuid/uuid.dart';

import '../../../core/constants/app_constants.dart';
import '../../../core/constants/enums.dart';
import '../../../core/utils/app_logger.dart';
import '../../../core/utils/combine_latest.dart';
import '../../../core/utils/safe_document_parser.dart';
import '../../../models/join_request_model.dart';
import '../../../models/owned_room_model.dart';
import '../../../models/room_model.dart';
import '../../../models/room_private_location.dart';
import '../auth/auth_service.dart';
import '../functions/functions_service.dart';

final ownerRepositoryProvider = Provider<OwnerRepository>((ref) {
  return OwnerRepository(
    firestore: ref.watch(firestoreProvider),
    auth: ref.watch(firebaseAuthProvider),
    functions: ref.watch(functionsServiceProvider),
  );
});

/// The files staged for one room edit.
///
/// The upload ids are the durable server-side handles. A staged object is
/// attached to the listing only by the server's commit callable; if the
/// edit fails, the same handle tells the server which unreferenced object
/// may be removed.
class _RoomImageUpload {
  final List<String> uploadIds;
  final List<String> newlyUploadedUrls;

  const _RoomImageUpload({
    required this.uploadIds,
    required this.newlyUploadedUrls,
  });
}

/// One room-create attempt which may still need to be reconciled.
///
/// The room id is retained after an ambiguous Firestore acknowledgement so a
/// retry updates the same listing instead of publishing a duplicate.
///
/// The upload ids of the staged photos are retained as well. The server
/// returns the same download URL for an upload id it already knows, so a
/// retry commits the **same** photo objects instead of uploading the same
/// bytes under a second URL. The committed photo list therefore cannot
/// contain the same photo twice.
class _PendingRoomCreation {
  final String roomId;

  /// The upload ids which this attempt already staged.
  final List<String> uploadIds;

  const _PendingRoomCreation(this.roomId, {this.uploadIds = const <String>[]});
}

/// The result of reading the room document after an ambiguous write.
enum _RoomCreationState { absent, matching, mismatched, unknown }

/// The result of reading the live publication state of a listing.
enum _PublicationState {
  /// The listing is live — the publication committed on the server.
  published,

  /// The listing is still a draft — the publication did not commit.
  notPublished,

  /// The live state could not be read.
  unknown,
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

/// A stable key for one form submission.
///
/// The form recreates its [RoomDraft] after every tap, including new
/// timestamps. The retry key therefore uses only the submitted listing data
/// and the selected photo names, not those transient timestamps.
String _roomCreationFingerprint(RoomDraft draft) {
  final room = draft.room;
  final location = draft.privateLocation;
  return jsonEncode(<String, dynamic>{
    'title': room.title.trim(),
    'description': room.description.trim(),
    'monthlyRent': room.monthlyRent,
    'securityDeposit': room.securityDeposit,
    'city': room.location.city.trim(),
    'state': room.location.state.trim(),
    'roomType': room.roomType.name,
    'furnishing': room.furnishing.name,
    'availableFrom': room.availableFrom.toUtc().toIso8601String(),
    'amenities': room.amenities,
    'occupancy': room.occupancy,
    'genderPreference': room.genderPreference.name,
    'address': location.address.trim(),
    'locationCity': location.city.trim(),
    'locationState': location.state.trim(),
    'pincode': location.pincode.trim(),
    // The home groups the listing in the owner's list. It is persisted with
    // the listing, so it has to be part of the attempt key: a retry which
    // only changes the selected home must not be folded into the earlier
    // attempt, which would keep the previous home on the listing.
    'homeId': room.homeId,
    'homeName': room.homeName,
    'newImages': draft.newImages.map((image) => image.name).toList(),
    'originalImages': draft.originalImageUrls,
  });
}

/// Data access for the room owner side of the app.
class OwnerRepository {
  final FirebaseFirestore _firestore;
  final FirebaseAuth _auth;
  final FunctionsService _functions;
  final Map<String, _PendingRoomCreation> _pendingRoomCreations =
      <String, _PendingRoomCreation>{};

  static const Uuid _uuid = Uuid();

  OwnerRepository({
    required this._firestore,
    required this._auth,
    required this._functions,
  });

  String? get _uid => _auth.currentUser?.uid;

  /// The collection which holds the **published** listings.
  ///
  /// A published listing is the only kind of listing which a student may
  /// read. The documents are created by the server.
  static const String publishedRoomsCollection = 'rooms';

  /// The collection which holds the **unfinished** listings.
  ///
  /// The drafts live in their own owner-scoped collection because a
  /// Firestore query cannot be filtered by the rules: a draft which shared
  /// the public collection would be returned by every query of it and would
  /// therefore be readable by every registered account.
  static const String roomDraftsCollection = 'roomDrafts';

  /// Rooms listed by the current owner.
  ///
  /// The public listing contains only coarse location data after the privacy
  /// migration. The owner view joins the server-owned private location back
  /// in so the edit form can still show and change the exact address.
  ///
  /// The published listings and the unfinished drafts live in two separate
  /// owner-scoped collections, so both of them are watched and merged. A
  /// draft which survived an interrupted publication has to stay visible to
  /// its owner — otherwise it could never be completed or removed.
  Stream<List<OwnedRoomModel>> watchMyRooms() {
    final uid = _uid;
    if (uid == null) return Stream.value([]);

    final published = _firestore
        .collection(publishedRoomsCollection)
        .where('ownerId', isEqualTo: uid)
        .orderBy('createdAt', descending: true)
        .snapshots();
    final drafts = _firestore
        .collection(roomDraftsCollection)
        .where('ownerId', isEqualTo: uid)
        .orderBy('createdAt', descending: true)
        .snapshots();

    return combineLatest2<
          QuerySnapshot<Map<String, dynamic>>,
          QuerySnapshot<Map<String, dynamic>>,
          List<QueryDocumentSnapshot<Map<String, dynamic>>>
        >(
          published,
          drafts,
          (publishedSnapshot, draftSnapshot) =>
              <QueryDocumentSnapshot<Map<String, dynamic>>>[
                ...publishedSnapshot.docs,
                ...draftSnapshot.docs,
              ],
        )
        .asyncMap((documents) => _mapOwnerRooms(documents, uid));
  }

  /// Joins the server-owned private location back into the owner's listings.
  Future<List<OwnedRoomModel>> _mapOwnerRooms(
    List<QueryDocumentSnapshot<Map<String, dynamic>>> documents,
    String uid,
  ) async {
    final rooms = <OwnedRoomModel>[];
    for (final doc in documents) {
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
        OwnedRoomModel(listing: listing, privateLocation: privateLocation),
      );
    }

    // The two collections are merged, so the order is restored here.
    rooms.sort((a, b) => b.createdAt.compareTo(a.createdAt));
    return rooms;
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

  /// Publishes a finished draft listing.
  ///
  /// The server owns the publication: it verifies that the listing belongs
  /// to the caller, that its private exact location exists and that every
  /// staged photo was committed. Only then does the listing become visible
  /// to students.
  Future<void> _publishRoomListing(String roomId) async {
    await _functions.callVoidFunction(
      'publishRoomListing',
      parameters: {'roomId': roomId},
      fallbackMessage: 'Could not publish the listing',
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

    final attemptKey = '$uid:${_roomCreationFingerprint(draft)}';
    final pendingCreation = _pendingRoomCreations[attemptKey];
    var roomId = pendingCreation?.roomId ?? 'RM-${_uuid.v4()}';
    var reuseExistingRoom = false;
    var reuseUploadIds = const <String>[];

    if (pendingCreation != null) {
      final existingState = await _reconcileRoomCreation(roomId, uid);
      if (existingState == _RoomCreationState.matching ||
          existingState == _RoomCreationState.unknown) {
        // The previous acknowledgement was ambiguous. Never overwrite this
        // room id: a retry must reconcile and complete the same listing.
        reuseExistingRoom = true;
        // The photos of the earlier attempt are staged under known upload
        // ids. Re-using them keeps the committed photo list free of
        // duplicates.
        reuseUploadIds = pendingCreation.uploadIds;
      } else if (existingState == _RoomCreationState.mismatched) {
        // The id no longer belongs to this owner. It cannot be reused safely.
        _pendingRoomCreations.remove(attemptKey);
        roomId = 'RM-${_uuid.v4()}';
      }
    }
    _pendingRoomCreations[attemptKey] = _PendingRoomCreation(roomId);

    // The unfinished listing is written into the owner-scoped draft
    // collection. It is not part of any public collection query, so no other
    // account can read it while it is being prepared.
    final roomRef = _firestore.collection(roomDraftsCollection).doc(roomId);
    final document = draft.room.copyWith(
      roomId: roomId,
      ownerId: uid,
      // Room photos are server-owned. The listing starts empty and the
      // server commit callable attaches only objects which it uploaded to
      // the exact owner/room path in the trusted bucket.
      images: const <String>[],
      createdAt: draft.room.createdAt,
      updatedAt: DateTime.now(),
      // A new listing never has tenants. The counter is server-owned from
      // the moment the listing exists.
      currentOccupancy: 0,
    );

    // The listing is created as a **draft**. It is not offered to students
    // and it cannot be booked while its photos and its private exact
    // location are still missing. The status is server-owned: the client may
    // not publish the listing by itself, and a listing without a status is
    // invisible to the student search anyway, because a Firestore equality
    // query never matches a document that does not have the field.
    //
    // The draft lives in its own collection, so no query of the public
    // listings can ever return it.
    final createPayload = document.toCreateJson()..['status'] = 'draft';

    var upload = const _RoomImageUpload(
      uploadIds: <String>[],
      newlyUploadedUrls: <String>[],
    );
    var listingRemoved = false;
    // The publication state of the listing. It stays `notPublished` while the
    // publication was never attempted, and it becomes `unknown` when the live
    // state could not be read. An unknown or a committed publication must
    // never lead to a deletion of the listing.
    var publicationState = _PublicationState.notPublished;
    try {
      if (!reuseExistingRoom) {
        try {
          await roomRef.set(createPayload);
        } catch (error) {
          // A Firestore error does not prove that the create failed. Re-read
          // the exact room document and verify both identity fields before
          // deciding that this attempt did not commit.
          final state = await _reconcileRoomCreation(roomId, uid);
          if (state != _RoomCreationState.matching) rethrow;
        }
      }

      upload = await _stageImages(
        roomId,
        draft,
        reuseUploadIds: reuseUploadIds,
      );
      // The upload ids are retained so a retry of this attempt stages the
      // same photo objects instead of uploading the same bytes a second time.
      _pendingRoomCreations[attemptKey] = _PendingRoomCreation(
        roomId,
        uploadIds: upload.uploadIds,
      );
      await _commitRoomPhotoChanges(roomId, draft, upload);

      try {
        // The public document starts with coarse locality data only. The
        // owner-only callable then stores the exact location privately and,
        // during the compatibility stage, keeps the legacy public fields in
        // the same transaction.
        await _writePrivateLocation(
          roomId,
          _draftPrivateLocation(draft, roomId: roomId, ownerId: uid),
        );
      } catch (error) {
        // A listing without its private counterpart is not a complete
        // listing. Remove it through the server so the photos and the
        // request history are cleaned up consistently.
        listingRemoved = await _deleteRoomListingBestEffort(roomId);
        rethrow;
      }

      try {
        // The listing is complete now. The server publishes it; only then is
        // it offered to students and only then can it be booked.
        await _publishRoomListing(roomId);
      } catch (error) {
        // A lost acknowledgement does not prove that the publication failed.
        // The live listing decides: a published listing is complete and must
        // never be removed by a failed retry.
        publicationState = await _readPublicationState(roomId, uid);
        if (publicationState == _PublicationState.notPublished) {
          // The publication really did not commit. The listing stays
          // invisible to students and is removed through the server so the
          // photos and the request history are cleaned up consistently.
          listingRemoved = await _deleteRoomListingBestEffort(roomId);
          rethrow;
        }
        if (publicationState == _PublicationState.unknown) {
          // The live state is unknown. The listing keeps its draft state, so
          // it is invisible to students and it is not removed on a guess.
          rethrow;
        }
        // The publication committed: the listing is complete.
        publicationState = _PublicationState.published;
      }
    } catch (error) {
      // A lost acknowledgement does not prove that the server commit failed.
      // The server-side discard operation checks the live listing before it
      // removes anything, so a committed photo is never deleted by a retry.
      await _discardUploadsBestEffort(roomId, upload.uploadIds);

      // Roll back only a listing whose owner and room identity were
      // confirmed. An ambiguous read leaves the pending room id in place so
      // the next form submission reconciles the same listing.
      //
      // A listing whose publication is unknown or committed is never removed:
      // the server may already have published it, and a published listing is
      // complete. The live status is checked as well, so a listing which was
      // published by another device in the meantime stays as it is.
      final roomState = await _reconcileRoomCreation(roomId, uid);
      final publicationUncertain =
          publicationState == _PublicationState.unknown ||
          publicationState == _PublicationState.published;
      if (!listingRemoved &&
          !publicationUncertain &&
          roomState == _RoomCreationState.matching &&
          await _roomIsUnpublishedAndEmpty(roomId, uid)) {
        listingRemoved = await _deleteRoomListingBestEffort(roomId);
      }
      if (listingRemoved ||
          roomState == _RoomCreationState.absent ||
          roomState == _RoomCreationState.mismatched) {
        _pendingRoomCreations.remove(attemptKey);
      }
      rethrow;
    }
    _pendingRoomCreations.remove(attemptKey);
    return roomId;
  }

  /// Updates one of the current owner's rooms.
  Future<void> updateRoom(RoomDraft draft) async {
    final uid = _uid;
    if (uid == null) throw Exception('User not logged in');

    // The listing is either a published listing or an unfinished draft. The
    // edit has to address the document which really holds it.
    final roomRef = await _resolveOwnerListingRef(draft.room.roomId, uid);

    // The live listing is validated **before** anything is committed.
    //
    // A rejected edit — for example a capacity below the number of people
    // who already live in the room — must not leave a new location or new
    // photos behind. The server-side location write and the photo commit are
    // separate, durable operations, so a failure between them cannot be
    // rolled back completely; the cheap validation therefore runs first.
    final currentOccupancy = await _readLiveOccupancy(roomRef, uid);
    _assertOwnerEditIsValid(draft, currentOccupancy);

    final upload = await _stageImages(draft.room.roomId, draft);
    final document = draft.room.copyWith(updatedAt: DateTime.now());

    try {
      // The owner-editable fields are committed in one transaction, and the
      // capacity is validated **inside** that same transaction.
      //
      // The tenant counter is server-owned: it is raised by the booking
      // activation and lowered by the rollback. The capacity therefore may
      // never be smaller than the number of people who already live there.
      // The booking activation reads the same document in its own
      // transaction and refuses to overbook a listing, so the two
      // transactions serialise: either this edit lowers the capacity first
      // and the activation sees the new capacity, or the activation raises
      // the counter first and this transaction sees the new counter.
      //
      // This transaction is therefore the **first** write of the edit. A
      // rejected edit never reaches the location write or the photo commit,
      // so it cannot leave a new address or new photos behind.
      //
      // The image list is deliberately omitted: it is server-owned, so this
      // write cannot restore a stale photo or forge a download URL.
      await _firestore.runTransaction((transaction) async {
        final snapshot = await transaction.get(roomRef);
        if (!snapshot.exists) throw Exception('Room not found');

        final data = snapshot.data();
        if (data?['ownerId'] != uid) {
          throw Exception('You can only edit your own listings');
        }

        final liveOccupancy = (data?['currentOccupancy'] as num?)?.toInt() ?? 0;
        _assertOwnerEditIsValid(draft, liveOccupancy);

        final payload = document.toOwnerUpdateJson()..remove('images');
        transaction.update(roomRef, payload);
      });

      // The exact location is written next. The server stores it privately
      // and updates the public compatibility fields in the same transaction,
      // so the address can never split across two different values.
      await _writePrivateLocation(
        draft.room.roomId,
        _draftPrivateLocation(draft, roomId: draft.room.roomId, ownerId: uid),
      );

      // Photo additions and removals are committed by the server. It reads
      // the live listing, so a photo added by another device while this form
      // was open is preserved. Only URLs which this form explicitly removed
      // are taken out of the list.
      await _commitRoomPhotoChanges(draft.room.roomId, draft, upload);
    } catch (error) {
      // The acknowledgement may have been lost after the server committed the
      // photo change. The server-side discard operation checks the live
      // listing before it removes anything.
      await _discardUploadsBestEffort(draft.room.roomId, upload.uploadIds);
      rethrow;
    }

    // The Firestore room-update trigger compares the committed image list
    // with the previous one and writes a durable server-side Storage-cleanup
    // job for every removed photo. The client deliberately does not delete
    // those objects: a stale client snapshot must never remove a photo which
    // a newer edit still references.
  }

  /// The document which holds the listing of one room id.
  ///
  /// The published listing wins over the draft: the publication moves the
  /// draft into the public collection, so both only exist at the same time
  /// when a stale draft survived an interrupted publication.
  Future<DocumentReference<Map<String, dynamic>>> _resolveOwnerListingRef(
    String roomId,
    String ownerId,
  ) async {
    final published = await _firestore
        .collection(publishedRoomsCollection)
        .doc(roomId)
        .get();
    if (published.exists) {
      if (published.data()?['ownerId'] != ownerId) {
        throw Exception('You can only edit your own listings');
      }
      return _firestore.collection(publishedRoomsCollection).doc(roomId);
    }

    final draft = await _firestore
        .collection(roomDraftsCollection)
        .doc(roomId)
        .get();
    if (!draft.exists) throw Exception('Room not found');
    if (draft.data()?['ownerId'] != ownerId) {
      throw Exception('You can only edit your own listings');
    }
    return _firestore.collection(roomDraftsCollection).doc(roomId);
  }

  /// The number of people who live in the listing right now.
  ///
  /// The read is the pre-flight check of an owner edit. It fails closed: a
  /// listing which cannot be read is not edited, because its current
  /// occupancy is unknown.
  Future<int> _readLiveOccupancy(
    DocumentReference<Map<String, dynamic>> roomRef,
    String ownerId,
  ) async {
    final snapshot = await roomRef.get();
    if (!snapshot.exists) throw Exception('Room not found');
    final data = snapshot.data();
    if (data?['ownerId'] != ownerId) {
      throw Exception('You can only edit your own listings');
    }
    return (data?['currentOccupancy'] as num?)?.toInt() ?? 0;
  }

  /// The owner-editable limits of one listing.
  ///
  /// The same limits are enforced by the Firestore rules and by the server.
  /// They are checked here before any side effect, so a rejected edit never
  /// changes the location or the photos of the listing.
  void _assertOwnerEditIsValid(RoomDraft draft, int currentOccupancy) {
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
    if (draft.room.occupancy < currentOccupancy) {
      throw Exception(
        'This room already has $currentOccupancy '
        '${currentOccupancy == 1 ? 'person' : 'people'} living in it, so '
        'the capacity cannot be lower than $currentOccupancy.',
      );
    }
  }

  /// Stages the newly picked photos with the server.
  ///
  /// The bytes are sent to a callable which verifies the live owner, the live
  /// listing, the image signature and the upload quota. The Admin SDK then
  /// writes the object below `rooms/{ownerUid}/{roomId}/…` in the trusted
  /// bucket. The client never receives a Storage write capability.
  ///
  /// [reuseUploadIds] carries the upload ids of an earlier attempt of the
  /// same listing. The server knows those ids already and returns the same
  /// download URLs, so a retry commits the same photo objects instead of
  /// uploading the same bytes a second time under a fresh URL. The committed
  /// photo list therefore never shows the same photo twice.
  Future<_RoomImageUpload> _stageImages(
    String roomId,
    RoomDraft draft, {
    List<String> reuseUploadIds = const <String>[],
  }) async {
    final uploadIds = <String>[];
    final uploadedUrls = <String>[];
    // The ids are only re-used when the earlier attempt staged exactly the
    // same number of photos. A different photo list gets fresh ids.
    final reusableIds = reuseUploadIds.length == draft.newImages.length
        ? reuseUploadIds
        : const <String>[];

    try {
      for (var index = 0; index < draft.newImages.length; index += 1) {
        final image = draft.newImages[index];
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

        final uploadId = index < reusableIds.length
            ? reusableIds[index]
            : _uuid.v4();
        // Track the id before the request. The server may have accepted the
        // object even when its acknowledgement was lost.
        uploadIds.add(uploadId);
        final result = await _functions.callFunction(
          'stageRoomPhoto',
          parameters: {
            'roomId': roomId,
            'uploadId': uploadId,
            'data': base64Encode(bytes),
            // These are advisory replacement hints. The server uses them
            // only to reserve a photo slot; the commit still recalculates
            // the authoritative final image list.
            'removeUrls': _plannedRemovalUrls(draft),
          },
        );
        final raw = result.data;
        if (raw is! Map) {
          throw Exception('The room-photo upload response was invalid.');
        }
        final data = Map<String, dynamic>.from(raw);
        final returnedUploadId = data['uploadId']?.toString().trim() ?? '';
        final url = data['url']?.toString().trim() ?? '';
        if (returnedUploadId.isEmpty || url.isEmpty) {
          throw Exception('The room-photo upload response was incomplete.');
        }
        if (returnedUploadId != uploadId) {
          uploadIds.add(returnedUploadId);
        }
        uploadedUrls.add(url);
      }
    } catch (error) {
      // A later upload may fail after earlier files were staged. The server
      // removes only objects which the live listing does not reference.
      await _discardUploadsBestEffort(roomId, uploadIds);
      AppLogger.warning('Could not upload a room photo', error: error);
      rethrow;
    }

    return _RoomImageUpload(
      uploadIds: uploadIds,
      newlyUploadedUrls: uploadedUrls,
    );
  }

  /// The photos which this form explicitly removed when it was opened.
  ///
  /// The difference is computed against the form's original image snapshot,
  /// so a concurrent edit cannot restore an image which another device already
  /// removed and cannot remove an image which this form never displayed.
  List<String> _plannedRemovalUrls(RoomDraft draft) {
    final retained = _safeImageUrls(draft.room.images).toSet();
    return _safeImageUrls(
      draft.originalImageUrls,
    ).where((url) => !retained.contains(url)).toList(growable: false);
  }

  /// Commits staged additions and this form's explicit removals.
  ///
  /// The same commit id is used for the retry. A lost acknowledgement is
  /// therefore idempotent on the server and can never append a duplicate
  /// photo.
  Future<void> _commitRoomPhotoChanges(
    String roomId,
    RoomDraft draft,
    _RoomImageUpload upload,
  ) async {
    final removedUrls = _plannedRemovalUrls(draft);
    if (upload.uploadIds.isEmpty && removedUrls.isEmpty) return;

    final commitId = _uuid.v4();
    final parameters = <String, dynamic>{
      'roomId': roomId,
      'commitId': commitId,
      'uploadIds': upload.uploadIds,
      'removeUrls': removedUrls,
    };

    Object? lastError;
    for (var attempt = 0; attempt < 2; attempt += 1) {
      try {
        await _functions.callFunction(
          'commitRoomPhotoChanges',
          parameters: parameters,
        );
        return;
      } catch (error) {
        lastError = error;
      }
    }

    // If both acknowledgements were lost, the live listing is the authority.
    // A commit which reached the server must not be mistaken for a failure
    // and cleaned up by the caller.
    final committed = await _photoChangesAreCommitted(
      roomId,
      upload.newlyUploadedUrls,
      removedUrls,
    );
    if (committed) return;
    throw lastError ?? Exception('Could not save the room photos.');
  }

  /// Whether the live listing already has the requested photo state.
  Future<bool> _photoChangesAreCommitted(
    String roomId,
    List<String> uploadedUrls,
    List<String> removedUrls,
  ) async {
    try {
      final images = await _readListingImages(roomId);
      if (images == null) return false;
      final known = images.toSet();
      final additionsPresent = uploadedUrls.every(known.contains);
      final removalsAbsent = removedUrls.every((url) => !known.contains(url));
      return additionsPresent && removalsAbsent;
    } catch (error) {
      AppLogger.warning(
        'Could not reconcile the committed room-photo change',
        error: error,
      );
      return false;
    }
  }

  /// The photo list of the listing which currently owns a room id.
  ///
  /// The listing is either a published listing or an unfinished draft. The
  /// published one wins, because the publication moves the draft into the
  /// public collection.
  Future<List<String>?> _readListingImages(String roomId) async {
    final published = await _firestore
        .collection(publishedRoomsCollection)
        .doc(roomId)
        .get();
    if (published.exists) {
      return _safeImageUrls(published.data()?['images']);
    }
    final draft = await _firestore
        .collection(roomDraftsCollection)
        .doc(roomId)
        .get();
    if (!draft.exists) return null;
    return _safeImageUrls(draft.data()?['images']);
  }

  /// Asks the server to remove staged objects which were never referenced.
  Future<void> _discardUploadsBestEffort(
    String roomId,
    List<String> uploadIds,
  ) async {
    for (final uploadId in uploadIds.toSet()) {
      try {
        await _functions.callVoidFunction(
          'discardRoomPhotoUpload',
          parameters: {'roomId': roomId, 'uploadId': uploadId},
          fallbackMessage: 'Could not remove an unused room photo',
        );
      } catch (error) {
        AppLogger.warning(
          'Could not discard an unused room-photo upload',
          error: error,
        );
      }
    }
  }

  /// Removes an incomplete listing through the server-owned deletion path.
  Future<bool> _deleteRoomListingBestEffort(String roomId) async {
    try {
      await _functions.callVoidFunction(
        'deleteRoomListing',
        parameters: {'roomId': roomId},
        fallbackMessage: 'Could not remove the incomplete listing',
      );
      return true;
    } catch (error) {
      AppLogger.warning(
        'Could not remove an incomplete room listing',
        error: error,
      );
      return false;
    }
  }

  /// Reconciles one ambiguous room-create acknowledgement.
  ///
  /// The document id alone is not proof that this owner created the room:
  /// both the stored owner id and the stored room id must match the attempt.
  /// The listing may be an unpublished draft or an already published
  /// listing — both are the result of this attempt.
  Future<_RoomCreationState> _reconcileRoomCreation(
    String roomId,
    String ownerId,
  ) async {
    try {
      final published = await _firestore
          .collection(publishedRoomsCollection)
          .doc(roomId)
          .get();
      if (published.exists) {
        final data = published.data();
        if (data?['ownerId'] != ownerId || data?['roomId'] != roomId) {
          return _RoomCreationState.mismatched;
        }
        return _RoomCreationState.matching;
      }
      final draft = await _firestore
          .collection(roomDraftsCollection)
          .doc(roomId)
          .get();
      if (!draft.exists) return _RoomCreationState.absent;
      final data = draft.data();
      if (data?['ownerId'] != ownerId || data?['roomId'] != roomId) {
        return _RoomCreationState.mismatched;
      }
      return _RoomCreationState.matching;
    } catch (error) {
      AppLogger.warning(
        'Could not reconcile the room-create acknowledgement',
        error: error,
      );
      return _RoomCreationState.unknown;
    }
  }

  /// Whether the live listing is confirmed to be an unpublished draft which
  /// carries no committed photo.
  ///
  /// A listing whose publication state is unknown must never be removed: the
  /// server may already have published it. A published listing is complete
  /// and stays, so the live status is checked here as well.
  Future<bool> _roomIsUnpublishedAndEmpty(String roomId, String ownerId) async {
    try {
      final published = await _firestore
          .collection(publishedRoomsCollection)
          .doc(roomId)
          .get();
      if (published.exists) {
        final data = published.data();
        if (data?['ownerId'] != ownerId || data?['roomId'] != roomId) {
          return false;
        }
        if (data?['status'] == 'available') {
          // The server published this listing. It is complete and must stay.
          return false;
        }
        return _safeImageUrls(data?['images']).isEmpty;
      }
      final draft = await _firestore
          .collection(roomDraftsCollection)
          .doc(roomId)
          .get();
      if (!draft.exists) return true;
      final data = draft.data();
      if (data?['ownerId'] != ownerId || data?['roomId'] != roomId) {
        return false;
      }
      return _safeImageUrls(data?['images']).isEmpty;
    } catch (error) {
      AppLogger.warning(
        'Could not verify the incomplete room listing',
        error: error,
      );
      return false;
    }
  }

  /// Reads the live publication state of one listing.
  ///
  /// The read is the reconciliation of an ambiguous `publishRoomListing`
  /// acknowledgement. It fails closed: a listing which cannot be read is
  /// reported as unknown, and an unknown state never removes a listing.
  Future<_PublicationState> _readPublicationState(
    String roomId,
    String ownerId,
  ) async {
    try {
      final snapshot = await _firestore
          .collection(publishedRoomsCollection)
          .doc(roomId)
          .get();
      if (!snapshot.exists) return _PublicationState.notPublished;
      final data = snapshot.data();
      if (data?['ownerId'] != ownerId || data?['roomId'] != roomId) {
        return _PublicationState.notPublished;
      }
      return data?['status'] == 'available'
          ? _PublicationState.published
          : _PublicationState.notPublished;
    } catch (error) {
      AppLogger.warning(
        'Could not reconcile the listing publication',
        error: error,
      );
      return _PublicationState.unknown;
    }
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
