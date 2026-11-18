import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/constants/enums.dart';
import '../../../core/utils/app_logger.dart';
import '../../../core/utils/safe_document_parser.dart';
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

/// Reads the saved-room ids from a user profile without trusting its shape.
///
/// Firestore does not enforce the element type of `savedRooms`. A document
/// edited by an older client or by the console can therefore contain a
/// number, a map, or `null` between two valid room ids. A direct
/// `map((item) => item as String)` cast used to throw on the first such
/// value, which broke the whole saved-rooms screen and prevented the user
/// from toggling any room.
List<String> savedRoomIdsFromProfile(dynamic value) {
  if (value is! List) return const <String>[];

  final roomIds = <String>[];
  final seen = <String>{};
  for (final item in value) {
    if (item is! String || item.trim().isEmpty) continue;
    // Keep the stored id byte-for-byte. The toggle uses Firestore's
    // `arrayRemove`, which compares the exact string; trimming it here but
    // removing the trimmed value would leave the original entry behind.
    if (!seen.add(item)) continue;
    roomIds.add(item);
  }
  return roomIds;
}

/// The number of matching rooms requested by one search page.
const int roomSearchPageSize = 60;

/// The number of raw Firestore documents inspected for one raw page.
const int roomSearchRawBatchSize = 60;

/// The maximum number of raw documents inspected by one search request.
///
/// A selective filter must not turn one "load more" action into an
/// unbounded collection scan. The cursor makes it safe to continue with the
/// next request.
const int roomSearchMaxScan = 300;

/// The position of a paginated room search.
///
/// The values match the query's `orderBy` fields. A rent-ordered search uses
/// `monthlyRent`, `createdAt` and `roomId`; every other ordering uses
/// `createdAt` and `roomId`.
///
/// The ordered values are kept exactly as Firestore returned them. Converting
/// every timestamp to a [DateTime] made a malformed numeric `createdAt` erase
/// the cursor, so the next page started at the beginning again.
class RoomSearchCursor {
  final String sort;
  final Object? monthlyRent;
  final Object createdAt;

  /// The Firestore document id used as the final, unique tie-breaker.
  ///
  /// The listing's `roomId` field cannot be used for this: a legacy listing
  /// may have an empty value while its document id is still unique. Mixing
  /// the two can make a cursor skip a room or repeat one forever.
  final String documentId;

  const RoomSearchCursor({
    required this.sort,
    required this.monthlyRent,
    required this.createdAt,
    required this.documentId,
  });

  /// Builds a cursor from one ordered Firestore document.
  ///
  /// A missing or non-orderable value cannot safely be used by `startAfter`.
  /// The caller must stop pagination in that case instead of reusing an older
  /// cursor and repeatedly fetching the same page.
  static RoomSearchCursor? fromDocumentData(
    Map<String, dynamic> data,
    String documentId,
    String sort,
  ) {
    final createdAt = data['createdAt'];
    if (!_isFirestoreOrderValue(createdAt)) return null;

    Object? monthlyRent;
    if (sort == 'lowest_rent' || sort == 'highest_rent') {
      monthlyRent = data['monthlyRent'];
      if (!_isFirestoreOrderValue(monthlyRent)) return null;
    }

    return RoomSearchCursor(
      sort: sort,
      monthlyRent: monthlyRent,
      createdAt: createdAt,
      documentId: documentId,
    );
  }

  /// The values passed to Firestore's `startAfter` cursor.
  List<Object?> get values {
    final rawCreatedAt = createdAt;
    final createdAtValue = rawCreatedAt is DateTime
        ? Timestamp.fromDate(rawCreatedAt)
        : rawCreatedAt;
    if (sort == 'lowest_rent' || sort == 'highest_rent') {
      return [monthlyRent, createdAtValue, documentId];
    }
    return [createdAtValue, documentId];
  }
}

/// Whether [value] can be used as a Firestore `orderBy`/`startAfter` value.
bool _isFirestoreOrderValue(Object? value) {
  return value is num ||
      value is String ||
      value is bool ||
      value is Timestamp ||
      value is Blob ||
      value is GeoPoint;
}

/// One bounded page of a room search.
class RoomSearchPage {
  final List<RoomModel> rooms;
  final RoomSearchCursor? cursor;
  final bool hasMore;
  final int scanned;

  const RoomSearchPage({
    required this.rooms,
    required this.cursor,
    required this.hasMore,
    required this.scanned,
  });
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
        return RoomModel.fromJson(snapshot.data()!, documentId: snapshot.id);
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
          (snapshot) => parseDocumentsSafely(
            snapshot.docs.map((doc) => (id: doc.id, data: doc.data())),
            (_, data) => JoinRequestModel.fromJson(data),
            onError: (id, error) => AppLogger.warning(
              'Could not read the join request $id',
              error: error,
            ),
          ),
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
      final saved = savedRoomIdsFromProfile(data?['savedRooms']);
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
      final saved = savedRoomIdsFromProfile(snapshot.data()?['savedRooms']);

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
    final saved = savedRoomIdsFromProfile(snapshot.data()?['savedRooms']);
    return saved.contains(roomId);
  }

  /// Rooms matching the given filters.
  ///
  /// The first page is read with a bounded Firestore query. Older pages are
  /// fetched explicitly with [searchRoomsPage]; the client never downloads
  /// the complete `rooms` collection merely to display a search result.
  ///
  /// The filters are applied **in Dart**, not in the Firestore query.
  /// Doing them server-side would need one composite index per possible
  /// combination of filters (status × room type × furnishing × gender ×
  /// city × rent range × sort order), and every missing one shows up as
  /// "Could not load rooms" in the search screen.
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
    int? limit,
  }) async* {
    final page = await searchRoomsPage(
      searchTerm: searchTerm,
      roomType: roomType,
      furnishing: furnishing,
      genderPreference: genderPreference,
      maxRent: maxRent,
      city: city,
      amenities: amenities,
      latitude: latitude,
      longitude: longitude,
      maxDistanceKm: maxDistanceKm,
      sort: sort,
      pageSize: limit != null && limit > 0 ? limit : roomSearchPageSize,
    );
    yield page.rooms;
  }

  /// Reads one cursor-based page of matching rooms.
  ///
  /// The raw Firestore page is bounded, but a selective filter may match no
  /// document in that page. In that case the repository continues through a
  /// limited number of raw pages until it has [pageSize] matches or reaches
  /// [roomSearchMaxScan] documents. The returned cursor always points after
  /// the last document which was actually inspected, so no matching room is
  /// skipped between two pages.
  Future<RoomSearchPage> searchRoomsPage({
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
    RoomSearchCursor? cursor,
    int pageSize = roomSearchPageSize,
  }) async {
    final effectivePageSize = pageSize > 0 ? pageSize : roomSearchPageSize;
    final effectiveSort = sort ?? 'relevance';
    final rentOrdered =
        effectiveSort == 'lowest_rent' || effectiveSort == 'highest_rent';

    // A cursor belongs to one ordering. Changing the sort starts a new
    // sequence instead of applying an incompatible cursor to the query.
    RoomSearchCursor? activeCursor = cursor?.sort == effectiveSort
        ? cursor
        : null;
    final matches = <RoomModel>[];
    var scanned = 0;
    var hasMore = false;

    while (matches.length < effectivePageSize && scanned < roomSearchMaxScan) {
      Query<Map<String, dynamic>> query = _firestore.collection('rooms');
      if (rentOrdered) {
        query = query
            .orderBy('monthlyRent', descending: effectiveSort == 'highest_rent')
            .orderBy('createdAt', descending: true)
            .orderBy(FieldPath.documentId);
      } else {
        query = query
            .orderBy('createdAt', descending: true)
            .orderBy(FieldPath.documentId);
      }
      if (activeCursor != null) query = query.startAfter(activeCursor.values);

      final remaining = roomSearchMaxScan - scanned;
      final batchSize = remaining < roomSearchRawBatchSize
          ? remaining
          : roomSearchRawBatchSize;
      final snapshot = await query.limit(batchSize).get();
      if (snapshot.docs.isEmpty) {
        hasMore = false;
        break;
      }

      var canAdvanceCursor = true;
      for (final doc in snapshot.docs) {
        scanned += 1;
        final nextCursor = _cursorFromDocument(doc, effectiveSort);
        if (nextCursor == null) {
          // Firestore returned a document whose ordered value cannot safely
          // be used by `startAfter`. Continuing with the previous cursor would
          // fetch this boundary page forever, so fail closed.
          canAdvanceCursor = false;
          break;
        }
        activeCursor = nextCursor;

        final RoomModel? room;
        try {
          final parsed = RoomModel.fromJson(doc.data(), documentId: doc.id);
          room = parsed;
        } catch (_) {
          // One malformed listing must not hide the rest of the page.
          continue;
        }

        if (!isRoomOfferedToStudents(room)) continue;
        if (!_roomMatchesFilters(
          room,
          searchTerm: searchTerm,
          roomType: roomType,
          furnishing: furnishing,
          genderPreference: genderPreference,
          maxRent: maxRent,
          city: city,
          amenities: amenities,
          latitude: latitude,
          longitude: longitude,
          maxDistanceKm: maxDistanceKm,
        )) {
          continue;
        }

        matches.add(room);
        if (matches.length >= effectivePageSize) break;
      }

      // A full raw page may have another page behind it. If the page was
      // partial, Firestore has reached the end of the collection.
      hasMore = canAdvanceCursor && snapshot.size == batchSize;
      if (!hasMore || matches.length >= effectivePageSize) break;
    }

    return RoomSearchPage(
      rooms: sortRooms(
        matches,
        effectiveSort,
        latitude: latitude,
        longitude: longitude,
      ),
      cursor: activeCursor,
      hasMore: hasMore,
      scanned: scanned,
    );
  }

  /// Builds the cursor for one raw room document.
  static RoomSearchCursor? _cursorFromDocument(
    QueryDocumentSnapshot<Map<String, dynamic>> doc,
    String sort,
  ) {
    return RoomSearchCursor.fromDocumentData(doc.data(), doc.id, sort);
  }

  /// Whether one room satisfies every active search filter.
  static bool _roomMatchesFilters(
    RoomModel room, {
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
  }) {
    if (roomType != null && room.roomType != roomType) return false;
    if (furnishing != null && room.furnishing != furnishing) return false;
    if (genderPreference != null && room.genderPreference != genderPreference) {
      return false;
    }
    if (maxRent != null && room.monthlyRent > maxRent) return false;

    if (city != null && city.isNotEmpty) {
      final wanted = city.trim().toLowerCase();
      if (room.location.city.trim().toLowerCase() != wanted) return false;
    }

    if (amenities != null && amenities.isNotEmpty) {
      // Every requested amenity has to be present. The comparison is
      // case-insensitive but exact — "AC" must not match "Air Conditioner"
      // (and, more importantly, "AC" must not match "Vacant" either).
      final owned = room.amenities.map((a) => a.trim().toLowerCase()).toSet();
      if (!amenities.every(
        (wanted) => owned.contains(wanted.trim().toLowerCase()),
      )) {
        return false;
      }
    }

    if (searchTerm != null && searchTerm.trim().isNotEmpty) {
      final term = searchTerm.trim().toLowerCase();
      final matchesText =
          room.title.toLowerCase().contains(term) ||
          room.description.toLowerCase().contains(term) ||
          room.location.city.toLowerCase().contains(term) ||
          // The amenities are searched as well, so the "AC Rooms" quick
          // filter on the home screen actually finds the rooms that have an
          // AC. The match is word-based: a plain `contains` would also hit
          // "Vacant" or "Place".
          _amenityMatches(room.amenities, term);
      if (!matchesText) return false;
    }

    // Only rooms with real coordinates can be measured. A room without a
    // position is not silently treated as "close by".
    if (maxDistanceKm != null && maxDistanceKm > 0) {
      final distance = room.distanceFrom(
        latitude: latitude,
        longitude: longitude,
      );
      if (distance == null || distance > maxDistanceKm) return false;
    }

    return true;
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
  ///
  /// This is public so a paginated result can be re-sorted after another
  /// page is appended; otherwise the first page would keep its old order
  /// while later pages used a different one.
  static List<RoomModel> sortRooms(
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
          rooms.add(RoomModel.fromJson(doc.data(), documentId: doc.id));
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
