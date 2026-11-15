import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/constants/enums.dart';
import '../../../core/utils/app_logger.dart';
import '../../../models/join_request_model.dart';
import '../../../models/room_model.dart';
import '../auth/auth_service.dart';

final studentRepositoryProvider = Provider<StudentRepository>((ref) {
  return StudentRepository(
    firestore: ref.watch(firestoreProvider),
    auth: ref.watch(firebaseAuthProvider),
  );
});

/// The raw data of one join-request snapshot.
///
/// The joined-room query is kept in this small, pure helper so its status
/// rules can be regression-tested without a Firestore emulator.
typedef JoinedRequestSnapshot = ({
  String documentId,
  Map<String, dynamic>? data,
});

/// Returns the room ids of requests that really represent a joined room.
///
/// Only `adminReviewed` and the legacy `admin_reviewed` spelling qualify.
/// A malformed request is skipped on its own; it must never hide all the
/// other joined rooms of the student.
List<String> joinedRoomIdsFromRequests(
  Iterable<JoinedRequestSnapshot> requests,
) {
  final roomIds = <String>[];

  for (final request in requests) {
    final data = request.data;
    if (data == null) continue;

    try {
      final model = JoinRequestModel.fromJson(data);
      if (!model.isAdminReviewed) continue;

      final roomId = data['roomId'];
      if (roomId is String && roomId.isNotEmpty) {
        roomIds.add(roomId);
      } else {
        AppLogger.warning(
          'Joined request ${request.documentId} has no room id; it cannot be '
          'shown on the joined-rooms screen.',
        );
      }
    } catch (error) {
      AppLogger.warning(
        'Could not read the joined request ${request.documentId}',
        error: error,
      );
    }
  }

  return roomIds.toSet().toList();
}

/// Whether a listing is offered to students.
///
/// A listing is on the market when its status is `available`; a **missing**
/// status means "available" as well (see `RoomModel.fromJson`), so an older
/// listing — or one that a client wrote without the field — is never lost.
/// A listing whose slots are all taken is not offered either.
///
/// The rule lives in a small, pure helper so it can be regression-tested
/// without a Firestore emulator.
bool isRoomOfferedToStudents(RoomModel room) {
  return room.status == RoomStatus.available && room.availableSlots > 0;
}

/// Data access for the student side of the app.
class StudentRepository {
  final FirebaseFirestore _firestore;
  final FirebaseAuth _auth;

  StudentRepository({required this._firestore, required this._auth});

  String? get _uid => _auth.currentUser?.uid;

  /// Watches a single room.
  Stream<RoomModel?> watchRoom(String roomId) {
    return _firestore.collection('rooms').doc(roomId).snapshots().map((
      snapshot,
    ) {
      if (!snapshot.exists) return null;
      try {
        return RoomModel.fromJson(snapshot.data()!);
      } catch (_) {
        return null;
      }
    });
  }

  /// Rooms the student has successfully joined.
  ///
  /// A room counts as joined once its join request reached the
  /// `adminReviewed` state. The legacy `admin_reviewed` spelling is
  /// accepted by [JoinRequestModel] as well.
  Stream<List<RoomModel>> watchJoinedRooms() {
    final uid = _uid;
    if (uid == null) return Stream.value([]);
    return watchJoinedRoomsForUid(uid);
  }

  /// Watches the joined rooms of [uid].
  ///
  /// The uid is passed in explicitly so the Riverpod provider can depend
  /// on the Firebase auth state. The old implementation read
  /// `currentUser` once; a provider created before Firebase restored the
  /// session therefore stayed empty for the whole lifetime of the screen.
  Stream<List<RoomModel>> watchJoinedRoomsForUid(String uid) {
    if (uid.isEmpty) return Stream.value([]);

    // The status filter is applied in Dart, not in the query: the legacy
    // spelling `admin_reviewed` is also a valid "joined" state, and a
    // Firestore `where` compares the raw string — so a legacy document
    // would silently never show up in the student's joined list.
    return _firestore
        .collection('joinRequests')
        .where('studentId', isEqualTo: uid)
        .snapshots()
        .asyncMap((snapshot) async {
          // The request snapshot already contains the room id. Re-reading the
          // request documents by id added another failure point and could lose
          // the room when the request changed between the two reads.
          final roomIds = joinedRoomIdsFromRequests(
            snapshot.docs.map((doc) => (documentId: doc.id, data: doc.data())),
          );

          return _roomsByIds(roomIds);
        });
  }

  /// Join requests the student has created, newest first.
  Stream<List<JoinRequestModel>> watchMyJoinRequests() {
    final uid = _uid;
    if (uid == null) return Stream.value([]);

    return _firestore
        .collection('joinRequests')
        .where('studentId', isEqualTo: uid)
        .orderBy('createdAt', descending: true)
        .snapshots()
        .map(
          (snapshot) => snapshot.docs
              .map((doc) => JoinRequestModel.fromJson(doc.data()))
              .toList(),
        );
  }

  /// Rooms the student has bookmarked.
  Stream<List<RoomModel>> watchSavedRooms() {
    final uid = _uid;
    if (uid == null) return Stream.value([]);

    return _firestore.collection('users').doc(uid).snapshots().asyncMap((
      snapshot,
    ) {
      final data = snapshot.data();
      final saved =
          (data?['savedRooms'] as List<dynamic>?)
              ?.map((e) => e as String)
              .toList() ??
          [];
      return _roomsByIds(saved);
    });
  }

  /// Adds or removes a room from the student's saved list.
  ///
  /// The toggle runs inside a transaction so that two quick taps (or the
  /// same account on two devices) cannot both read the pre-toggle state and
  /// then write it back — which used to silently drop one of the saves.
  Future<void> toggleSavedRoom(String roomId) async {
    final uid = _uid;
    if (uid == null) throw Exception('User not logged in');

    final ref = _firestore.collection('users').doc(uid);
    await _firestore.runTransaction((transaction) async {
      final snapshot = await transaction.get(ref);
      final saved =
          (snapshot.data()?['savedRooms'] as List<dynamic>?)
              ?.map((e) => e as String)
              .toList() ??
          [];

      if (saved.contains(roomId)) {
        transaction.update(ref, {
          'savedRooms': FieldValue.arrayRemove([roomId]),
          'updatedAt': FieldValue.serverTimestamp(),
        });
      } else {
        transaction.update(ref, {
          'savedRooms': FieldValue.arrayUnion([roomId]),
          'updatedAt': FieldValue.serverTimestamp(),
        });
      }
    });
  }

  /// Whether [roomId] is in the student's saved list.
  Future<bool> isRoomSaved(String roomId) async {
    final uid = _uid;
    if (uid == null) return false;
    final snapshot = await _firestore.collection('users').doc(uid).get();
    final saved =
        (snapshot.data()?['savedRooms'] as List<dynamic>?)
            ?.map((e) => e as String)
            .toList() ??
        [];
    return saved.contains(roomId);
  }

  /// Rooms matching the given filters.
  ///
  /// The filters are applied **in Dart**, not in the Firestore query.
  ///
  /// Doing them server-side would need one composite index per possible
  /// combination of filters (status × room type × furnishing × gender ×
  /// city × rent range × sort order), and every missing one shows up as
  /// "Could not load rooms" in the search screen. The single query below
  /// only needs the `createdAt` index, always works, and — as a
  /// bonus — the free-text search now looks at the whole candidate set
  /// instead of only the newest 50 rooms.
  ///
  /// The listing status is filtered here as well, and **not** in the query:
  /// a Firestore equality query never matches a document that does not
  /// have the field, so a listing whose `status` is missing (an older
  /// document, or one created by a client that left it out) would be
  /// invisible to every student — even though it is a perfectly valid,
  /// available listing.
  Stream<List<RoomModel>> searchRooms({
    String? searchTerm,
    RoomType? roomType,
    FurnishingType? furnishing,
    GenderPreference? genderPreference,
    double? maxRent,
    String? city,
    List<String>? amenities,
    double? latitude,
    double? longitude,
    double? maxDistanceKm,
    String? sort,
    int limit = 300,
  }) {
    return _firestore
        .collection('rooms')
        .orderBy('createdAt', descending: true)
        .limit(limit)
        .snapshots()
        .map((snapshot) {
          // A single malformed room document must not take the whole list down.
          var rooms = snapshot.docs
              .map((doc) {
                try {
                  return RoomModel.fromJson(doc.data());
                } catch (_) {
                  return null;
                }
              })
              .whereType<RoomModel>()
              .toList();

          // Only the listings that are on the market are offered. A missing
          // status means "available" (see `RoomModel.fromJson`), so an
          // older listing is never lost.
          rooms = rooms.where(isRoomOfferedToStudents).toList();

          var result = rooms;

          if (roomType != null) {
            result = result.where((r) => r.roomType == roomType).toList();
          }
          if (furnishing != null) {
            result = result.where((r) => r.furnishing == furnishing).toList();
          }
          if (genderPreference != null) {
            result = result
                .where((r) => r.genderPreference == genderPreference)
                .toList();
          }
          if (maxRent != null) {
            result = result.where((r) => r.monthlyRent <= maxRent).toList();
          }
          if (city != null && city.isNotEmpty) {
            final wanted = city.trim().toLowerCase();
            result = result
                .where((r) => r.location.city.trim().toLowerCase() == wanted)
                .toList();
          }
          if (amenities != null && amenities.isNotEmpty) {
            // Every requested amenity has to be present. The comparison is
            // case-insensitive but exact — "AC" must not match "Air Conditioner"
            // (and, more importantly, "AC" must not match "Vacant" either).
            result = result.where((room) {
              final owned = room.amenities
                  .map((a) => a.trim().toLowerCase())
                  .toSet();
              return amenities.every(
                (wanted) => owned.contains(wanted.trim().toLowerCase()),
              );
            }).toList();
          }

          // ---------------------------------------------------------------
          // A room whose status is still `available` but whose slots are all
          // taken must not be offered to a student. The check above already
          // covers that (`isRoomOfferedToStudents`), so nothing is filtered
          // again here.
          // ---------------------------------------------------------------

          if (searchTerm != null && searchTerm.trim().isNotEmpty) {
            final term = searchTerm.trim().toLowerCase();
            result = result.where((room) {
              return room.title.toLowerCase().contains(term) ||
                  room.description.toLowerCase().contains(term) ||
                  room.location.address.toLowerCase().contains(term) ||
                  room.location.city.toLowerCase().contains(term) ||
                  room.location.pincode.contains(term) ||
                  // The amenities are searched as well, so the "AC Rooms" quick
                  // filter on the home screen actually finds the rooms that
                  // have an AC. The match is word-based: a plain `contains`
                  // would also hit "Vacant" or "Place".
                  _amenityMatches(room.amenities, term);
            }).toList();
          }

          // ---------------------------------------------------------------
          // The distance filter. Only the rooms that really have coordinates
          // can be measured — a room without a position is *not* silently
          // treated as "close by".
          // ---------------------------------------------------------------
          if (maxDistanceKm != null && maxDistanceKm > 0) {
            result = result.where((room) {
              final distance = room.distanceFrom(
                latitude: latitude,
                longitude: longitude,
              );
              return distance != null && distance <= maxDistanceKm;
            }).toList();
          }

          return _sortRooms(
            result,
            sort,
            latitude: latitude,
            longitude: longitude,
          );
        });
  }

  /// Whether one of the amenities matches [term].
  ///
  /// The term has to match a whole word of the amenity ("AC" matches
  /// "AC" and "AC Room", but not "Vacant" or "Balcony").
  static bool _amenityMatches(List<String> amenities, String term) {
    for (final amenity in amenities) {
      final words = amenity
          .toLowerCase()
          .split(RegExp(r'[^a-z0-9]+'))
          .where((word) => word.isNotEmpty)
          .toList();
      if (words.contains(term)) return true;
    }
    return false;
  }

  /// Applies the sort the user picked in the search screen.
  List<RoomModel> _sortRooms(
    List<RoomModel> rooms,
    String? sort, {
    double? latitude,
    double? longitude,
  }) {
    final sorted = List<RoomModel>.from(rooms);
    switch (sort) {
      case 'lowest_rent':
        sorted.sort((a, b) => a.monthlyRent.compareTo(b.monthlyRent));
      case 'highest_rent':
        sorted.sort((a, b) => b.monthlyRent.compareTo(a.monthlyRent));
      case 'newest':
        sorted.sort((a, b) => b.createdAt.compareTo(a.createdAt));
      case 'distance':
        // The rooms without coordinates go to the end — they cannot be
        // compared with the others.
        sorted.sort((a, b) {
          final distanceA = a.distanceFrom(
            latitude: latitude,
            longitude: longitude,
          );
          final distanceB = b.distanceFrom(
            latitude: latitude,
            longitude: longitude,
          );
          if (distanceA == null && distanceB == null) return 0;
          if (distanceA == null) return 1;
          if (distanceB == null) return -1;
          return distanceA.compareTo(distanceB);
        });
      case 'relevance':
      default:
        // "Relevance" keeps the server order (newest first).
        break;
    }
    return sorted;
  }

  Future<List<RoomModel>> _roomsByIds(List<String> roomIds) async {
    if (roomIds.isEmpty) return [];

    // `whereIn` accepts at most 30 values per query, so the ids are split
    // into chunks — otherwise a student with more than 30 saved rooms got
    // an `INVALID_ARGUMENT` error and the whole list disappeared.
    final rooms = <RoomModel>[];
    for (final chunk in _chunk(roomIds)) {
      final snapshot = await _firestore
          .collection('rooms')
          .where(FieldPath.documentId, whereIn: chunk)
          .get();
      for (final doc in snapshot.docs) {
        try {
          rooms.add(RoomModel.fromJson(doc.data()));
        } catch (_) {
          // Skip a malformed room instead of failing the whole list.
        }
      }
    }
    return rooms;
  }

  /// Splits [ids] into chunks of at most 30 — the Firestore `in` limit.
  static List<List<String>> _chunk(List<String> ids) {
    const max = 30;
    if (ids.length <= max) return [ids];
    final chunks = <List<String>>[];
    for (var i = 0; i < ids.length; i += max) {
      chunks.add(ids.sublist(i, i + max > ids.length ? ids.length : i + max));
    }
    return chunks;
  }
}
