// Regression tests for the reconciliation of an ambiguous room-create
// acknowledgement.
//
// A Firestore write can commit even when its acknowledgement is lost. The
// owner repository therefore re-reads the exact room document before it
// decides that a create failed, and it keeps the room id of an unresolved
// attempt so that a retry completes the **same** listing instead of
// publishing a second one.
//
// The Firestore types are annotated `@sealed`. That annotation is advisory
// for the analyzer — it only warns that the types are meant to be
// implemented by the package itself — and the double has to implement them
// to be usable at all.
//
// ignore_for_file: subtype_of_sealed_class

import 'dart:typed_data';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_auth_mocks/firebase_auth_mocks.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image_picker/image_picker.dart';

import 'package:stayserve/core/constants/enums.dart';
import 'package:stayserve/firebase/functions/functions_service.dart';
import 'package:stayserve/firebase/owner/owner_repository.dart';
import 'package:stayserve/models/room_model.dart';
import 'package:stayserve/models/room_private_location.dart';

class _UnavailableFirebaseFunctions implements FirebaseFunctions {
  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw UnimplementedError('Functions are not available in this test');
}

/// Records every callable the repository makes.
class _RecordingFunctionsService extends FunctionsService {
  _RecordingFunctionsService() : super(_UnavailableFirebaseFunctions());

  final List<String> calls = <String>[];
  final Map<String, Map<String, dynamic>> parameters =
      <String, Map<String, dynamic>>{};

  /// The callables which fail with this error.
  final Set<String> failing = <String>{};

  /// The parameters of **every** call, in order.
  final List<Map<String, Map<String, dynamic>>> callHistory =
      <Map<String, Map<String, dynamic>>>[];

  /// Runs before a failing callable throws.
  ///
  /// It models a server which committed the operation but whose
  /// acknowledgement never reached the client.
  void Function(String name, Map<String, dynamic> parameters)? onFailingCall;

  /// Builds the response of a callable.
  ///
  /// The default response is the generic success marker. A test which needs
  /// a real payload — the staged photo, for example — provides its own.
  Map<String, dynamic> Function(String name, Map<String, dynamic> parameters)?
  responseBuilder;

  @override
  Future<HttpsCallableResult> callFunction(
    String name, {
    Map<String, dynamic>? parameters,
  }) async {
    calls.add(name);
    final recorded = Map<String, dynamic>.from(
      parameters ?? const <String, dynamic>{},
    );
    this.parameters[name] = recorded;
    callHistory.add(<String, Map<String, dynamic>>{name: recorded});
    if (failing.contains(name)) {
      onFailingCall?.call(name, recorded);
      throw Exception('The callable $name failed.');
    }
    final data =
        responseBuilder?.call(name, recorded) ??
        <String, dynamic>{'success': true};
    return _FakeCallableResult(data);
  }
}

class _FakeCallableResult implements HttpsCallableResult<dynamic> {
  _FakeCallableResult(this.data);

  @override
  final dynamic data;

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

/// A Firestore double for the room collections.
///
/// The published listings live in `rooms` and the unfinished drafts live in
/// `roomDrafts`. A draft has its own collection because a Firestore query
/// cannot be filtered by the rules: a draft which shared the public
/// collection would be returned by every query of it.
class _FakeFirestore implements FirebaseFirestore {
  /// The stored published listings, keyed by their id.
  final Map<String, Map<String, dynamic>> rooms =
      <String, Map<String, dynamic>>{};

  /// The stored draft listings, keyed by their id.
  final Map<String, Map<String, dynamic>> drafts =
      <String, Map<String, dynamic>>{};

  /// The ids of the documents which were written.
  final List<String> writes = <String>[];

  /// The collection of every write, in order.
  final List<String> writeCollections = <String>[];

  /// The payloads of the documents which were written.
  final List<Map<String, dynamic>> payloads = <Map<String, dynamic>>[];

  /// When set, the next `set` throws this error **after** it stored the
  /// document. It models a lost acknowledgement.
  Object? lostAcknowledgement;

  /// When set, the next `set` throws this error **without** storing the
  /// document. It models a create which did not commit.
  Object? failedWrite;

  /// When set, every `get` throws this error. It models an unreadable
  /// document, which leaves the state of the attempt unknown.
  Object? unreadable;

  /// When set, the **next** `get` throws this error and the flag is cleared.
  ///
  /// It models a transient read failure: the reconciliation of one attempt
  /// cannot read the listing, while a later read succeeds.
  Object? failNextGet;

  /// Runs after every read. It models a concurrent change of the listing.
  void Function(String id)? afterGet;

  /// The store which belongs to a collection path.
  Map<String, Map<String, dynamic>> storeOf(String path) {
    if (path == 'rooms') return rooms;
    if (path == 'roomDrafts') return drafts;
    throw StateError('Unexpected collection: $path');
  }

  @override
  CollectionReference<Map<String, dynamic>> collection(String path) {
    // Touch the store so that an unknown collection fails immediately.
    storeOf(path);
    return _FakeRoomCollection(this, path);
  }

  @override
  Future<T> runTransaction<T>(
    TransactionHandler<T> updateFunction, {
    int maxAttempts = 5,
    Duration? timeout,
  }) async {
    return updateFunction(_FakeTransaction(this));
  }

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw StateError('Firestore is not available in this test');
}

/// A transaction double for the room collections.
class _FakeTransaction implements Transaction {
  _FakeTransaction(this.firestore);

  final _FakeFirestore firestore;

  @override
  Future<DocumentSnapshot<T>> get<T extends Object?>(
    DocumentReference<T> documentReference,
  ) async {
    final unreadable = firestore.unreadable;
    if (unreadable != null) throw unreadable;
    final failed = firestore.failNextGet;
    if (failed != null) {
      firestore.failNextGet = null;
      throw failed;
    }
    final id = documentReference.id;
    final path = documentReference.path;
    final collectionPath = path.split('/').first;
    final store = firestore.storeOf(collectionPath);
    final snapshot = _FakeRoomSnapshot(id, store[id]) as DocumentSnapshot<T>;
    firestore.afterGet?.call(id);
    return snapshot;
  }

  @override
  Transaction update(
    DocumentReference<Object?> documentReference,
    Map<String, dynamic> data,
  ) {
    final id = documentReference.id;
    final path = documentReference.path;
    final collectionPath = path.split('/').first;
    final store = firestore.storeOf(collectionPath);
    firestore.writes.add(id);
    firestore.writeCollections.add(collectionPath);
    firestore.payloads.add(Map<String, dynamic>.from(data));
    store[id] = <String, dynamic>{...?store[id], ...data};
    return this;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw StateError('Firestore is not available in this test');
}

class _FakeRoomCollection implements CollectionReference<Map<String, dynamic>> {
  _FakeRoomCollection(this.firestore, this.collectionPath);

  @override
  final _FakeFirestore firestore;

  /// The collection which this reference addresses.
  final String collectionPath;

  @override
  String get id => collectionPath;

  @override
  String get path => collectionPath;

  @override
  DocumentReference<Map<String, dynamic>> doc([String? path]) {
    return _FakeRoomDocument(firestore, collectionPath, path ?? '');
  }

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw StateError('Firestore is not available in this test');
}

class _FakeRoomDocument implements DocumentReference<Map<String, dynamic>> {
  _FakeRoomDocument(this.firestore, this.collectionPath, this.id);

  @override
  final _FakeFirestore firestore;

  /// The collection which this document belongs to.
  final String collectionPath;

  @override
  final String id;

  @override
  String get path => '$collectionPath/$id';

  @override
  CollectionReference<Map<String, dynamic>> collection(String collectionPath) {
    return firestore.collection(collectionPath);
  }

  @override
  Future<void> set(Map<String, dynamic> data, [SetOptions? options]) async {
    final store = firestore.storeOf(collectionPath);
    final failed = firestore.failedWrite;
    if (failed != null) {
      firestore.failedWrite = null;
      firestore.writes.add(id);
      firestore.writeCollections.add(collectionPath);
      throw failed;
    }

    firestore.writes.add(id);
    firestore.writeCollections.add(collectionPath);
    firestore.payloads.add(Map<String, dynamic>.from(data));
    if (options is SetOptions && options.merge == true) {
      store[id] = <String, dynamic>{...?store[id], ...data};
    } else {
      store[id] = Map<String, dynamic>.from(data);
    }
    final lost = firestore.lostAcknowledgement;
    if (lost != null) {
      firestore.lostAcknowledgement = null;
      throw lost;
    }
  }

  @override
  Future<DocumentSnapshot<Map<String, dynamic>>> get([
    GetOptions? options,
  ]) async {
    final unreadable = firestore.unreadable;
    if (unreadable != null) throw unreadable;
    final failed = firestore.failNextGet;
    if (failed != null) {
      firestore.failNextGet = null;
      throw failed;
    }
    final store = firestore.storeOf(collectionPath);
    final snapshot = _FakeRoomSnapshot(id, store[id]);
    firestore.afterGet?.call(id);
    return snapshot;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw StateError('Firestore is not available in this test');
}

class _FakeRoomSnapshot implements DocumentSnapshot<Map<String, dynamic>> {
  _FakeRoomSnapshot(this.id, this._data);

  @override
  final String id;

  final Map<String, dynamic>? _data;

  @override
  Map<String, dynamic>? data() => _data;

  @override
  bool get exists => _data != null;

  @override
  SnapshotMetadata get metadata => _FakeSnapshotMetadata();

  @override
  DocumentReference<Map<String, dynamic>> get reference =>
      throw UnimplementedError();

  @override
  dynamic get(Object field) => _data?[field.toString()];

  @override
  dynamic operator [](Object field) => get(field);
}

class _FakeSnapshotMetadata implements SnapshotMetadata {
  @override
  bool get hasPendingWrites => false;

  @override
  bool get isFromCache => false;
}

RoomDraft _draft({RoomModel? room}) {
  final now = DateTime.utc(2026, 1, 1);
  return RoomDraft(
    room:
        room ??
        RoomModel(
          roomId: '',
          ownerId: 'owner-1',
          title: 'Sunny room near the campus',
          description: 'A comfortable room.',
          monthlyRent: 6000,
          securityDeposit: 12000,
          location: const Location(city: 'Bengaluru', state: 'Karnataka'),
          roomType: RoomType.single,
          furnishing: FurnishingType.semi,
          availableFrom: now,
          amenities: const <String>['WiFi'],
          occupancy: 2,
          currentOccupancy: 0,
          genderPreference: GenderPreference.any,
          images: const <String>[],
          status: RoomStatus.available,
          createdAt: now,
          updatedAt: now,
        ),
    privateLocation: RoomPrivateLocation(
      roomId: '',
      ownerId: 'owner-1',
      address: '42 Test Street',
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560001',
      latitude: 12.9716,
      longitude: 77.5946,
      updatedAt: now,
    ),
  );
}

/// A draft which carries one photo which still has to be uploaded.
RoomDraft _draftWithImage() {
  final draft = _draft();
  return RoomDraft(
    room: draft.room,
    privateLocation: draft.privateLocation,
    newImages: <XFile>[
      XFile.fromData(
        Uint8List.fromList(<int>[
          0xFF,
          0xD8,
          0xFF,
          0xE0,
          0x00,
          0x10,
          0x4A,
          0x46,
          0x49,
          0x46,
        ]),
        name: 'room-photo.jpg',
      ),
    ],
  );
}

OwnerRepository _repository({
  required _FakeFirestore firestore,
  required _RecordingFunctionsService functions,
}) {
  final auth = MockFirebaseAuth(
    signedIn: true,
    mockUser: MockUser(uid: 'owner-1', email: 'owner@example.test'),
  );
  return OwnerRepository(
    firestore: firestore,
    auth: auth,
    functions: functions,
  );
}

/// Models the server-side publication of a draft.
///
/// The publication **moves** the draft into the public collection and marks
/// the copy as available. A draft which stayed behind would still be
/// invisible, but the listing would exist twice.
void _simulatePublishedListing(_FakeFirestore firestore, String roomId) {
  final draft = firestore.drafts.remove(roomId);
  if (draft == null) return;
  firestore.rooms[roomId] = <String, dynamic>{...draft, 'status': 'available'};
}

void main() {
  group('the room-create acknowledgement is reconciled', () {
    test('a lost acknowledgement completes the same listing', () async {
      final firestore = _FakeFirestore();
      final functions = _RecordingFunctionsService();
      // The write commits, but its acknowledgement is lost.
      firestore.lostAcknowledgement = Exception('The write timed out.');

      final roomId = await _repository(
        firestore: firestore,
        functions: functions,
      ).createRoom(_draft());

      expect(firestore.drafts.length, 1);
      expect(firestore.drafts.containsKey(roomId), isTrue);
      expect(firestore.rooms.containsKey(roomId), isFalse);
      expect(firestore.writes, <String>[roomId]);
      expect(firestore.writeCollections, <String>['roomDrafts']);
      expect(functions.parameters['setRoomPrivateLocation']?['roomId'], roomId);
      // The retry must not publish a second listing.
      expect(firestore.writes.length, 1);
    });

    test('an unreadable listing keeps the room id for the retry', () async {
      final firestore = _FakeFirestore();
      final functions = _RecordingFunctionsService();
      final repository = _repository(
        firestore: firestore,
        functions: functions,
      );
      // The write fails and the document cannot be read, so the state of the
      // attempt stays unknown.
      firestore.failedWrite = Exception('The write failed.');
      firestore.unreadable = Exception('The document is unavailable.');

      await expectLater(
        repository.createRoom(_draft()),
        throwsA(isA<Exception>()),
      );
      expect(firestore.writes.length, 1);
      final firstRoomId = firestore.writes.single;

      // The listing becomes readable again. The retry has to complete the
      // same listing instead of publishing a second one.
      firestore.unreadable = null;
      final roomId = await repository.createRoom(_draft());

      expect(roomId, firstRoomId);
      expect(firestore.drafts.length, 1);
      expect(firestore.drafts.keys.single, firstRoomId);
    });

    test('a listing of another owner is never reused', () async {
      final firestore = _FakeFirestore();
      final functions = _RecordingFunctionsService();
      final repository = _repository(
        firestore: firestore,
        functions: functions,
      );
      firestore.failedWrite = Exception('The write failed.');
      firestore.unreadable = Exception('The document is unavailable.');

      await expectLater(
        repository.createRoom(_draft()),
        throwsA(isA<Exception>()),
      );
      final firstRoomId = firestore.writes.single;

      // Somebody else owns the document under the pending id.
      firestore.unreadable = null;
      firestore.drafts[firstRoomId] = <String, dynamic>{
        'roomId': firstRoomId,
        'ownerId': 'owner-2',
      };

      final roomId = await repository.createRoom(_draft());

      expect(roomId, isNot(firstRoomId));
      expect(firestore.drafts[roomId]?['ownerId'], 'owner-1');
    });

    test('a failed private location removes the incomplete listing', () async {
      final firestore = _FakeFirestore();
      final functions = _RecordingFunctionsService();
      functions.failing.add('setRoomPrivateLocation');

      await expectLater(
        _repository(
          firestore: firestore,
          functions: functions,
        ).createRoom(_draft()),
        throwsA(isA<Exception>()),
      );

      // The incomplete listing is removed through the server-owned path.
      expect(functions.calls, contains('deleteRoomListing'));
      expect(
        functions.parameters['deleteRoomListing']?['roomId'],
        firestore.writes.single,
      );
    });

    test(
      'a new listing is created as a draft and published by the server',
      () async {
        final firestore = _FakeFirestore();
        final functions = _RecordingFunctionsService();

        final roomId = await _repository(
          firestore: firestore,
          functions: functions,
        ).createRoom(_draft());

        // The client may not publish the listing by itself: the status of a
        // fresh listing is the server-owned draft state.
        expect(firestore.payloads.single['status'], 'draft');
        expect(firestore.payloads.single['currentOccupancy'], 0);
        expect(
          functions.calls,
          containsAllInOrder(<String>[
            'setRoomPrivateLocation',
            'publishRoomListing',
          ]),
        );
        expect(functions.parameters['publishRoomListing']?['roomId'], roomId);
      },
    );

    test(
      'a lost publication acknowledgement keeps the published listing',
      () async {
        final firestore = _FakeFirestore();
        final functions = _RecordingFunctionsService();
        functions.failing.add('publishRoomListing');
        // The server published the listing, but the acknowledgement was lost.
        functions.onFailingCall = (name, parameters) {
          if (name != 'publishRoomListing') return;
          _simulatePublishedListing(firestore, parameters['roomId'] as String);
        };

        final roomId = await _repository(
          firestore: firestore,
          functions: functions,
        ).createRoom(_draft());

        // The listing is complete: it must not be removed by the failed
        // acknowledgement.
        expect(firestore.rooms[roomId]?['status'], 'available');
        expect(firestore.drafts.containsKey(roomId), isFalse);
        expect(functions.calls, isNot(contains('deleteRoomListing')));
      },
    );

    test('an unknown publication state keeps the draft listing', () async {
      final firestore = _FakeFirestore();
      final functions = _RecordingFunctionsService();
      functions.failing.add('publishRoomListing');

      // The publication failed and the live state cannot be read.
      firestore.unreadable = Exception('The document is unavailable.');

      await expectLater(
        _repository(
          firestore: firestore,
          functions: functions,
        ).createRoom(_draft()),
        throwsA(isA<Exception>()),
      );

      // The listing stays a draft. It is invisible to students and it is
      // not removed on a guess.
      expect(functions.calls, isNot(contains('deleteRoomListing')));
    });

    test(
      'a transient publication read failure never deletes the listing',
      () async {
        final firestore = _FakeFirestore();
        final functions = _RecordingFunctionsService();
        functions.failing.add('publishRoomListing');
        // The server may already have published the listing. Only the read
        // of the publication state fails; every later read succeeds.
        firestore.failNextGet = Exception('The document is unavailable.');

        await expectLater(
          _repository(
            firestore: firestore,
            functions: functions,
          ).createRoom(_draft()),
          throwsA(isA<Exception>()),
        );

        // The publication state was unknown, so the listing must not be
        // removed: the server may already have published it.
        expect(functions.calls, isNot(contains('deleteRoomListing')));
      },
    );

    test(
      'a published listing is never removed by the rollback of a retry',
      () async {
        final firestore = _FakeFirestore();
        final functions = _RecordingFunctionsService();
        functions.failing.add('publishRoomListing');
        // The server published the listing before the acknowledgement was
        // lost, so the live status is `available` even though the client
        // never learned about it.
        functions.onFailingCall = (name, parameters) {
          if (name != 'publishRoomListing') return;
          _simulatePublishedListing(firestore, parameters['roomId'] as String);
        };
        // The publication state cannot be read, so it stays unknown.
        firestore.failNextGet = Exception('The document is unavailable.');

        await expectLater(
          _repository(
            firestore: firestore,
            functions: functions,
          ).createRoom(_draft()),
          throwsA(isA<Exception>()),
        );

        // The live listing is published and complete: it stays.
        expect(functions.calls, isNot(contains('deleteRoomListing')));
        expect(firestore.rooms.values.single['status'], 'available');
      },
    );

    test('a retry re-uses the staged upload ids of the same attempt', () async {
      final firestore = _FakeFirestore();
      final functions = _RecordingFunctionsService();
      // The private location fails and the cleanup of the incomplete listing
      // fails as well, so the attempt stays pending and the retry has to
      // reconcile the same listing.
      functions.failing.add('setRoomPrivateLocation');
      functions.failing.add('deleteRoomListing');
      functions.responseBuilder = (name, parameters) {
        if (name != 'stageRoomPhoto') return <String, dynamic>{'success': true};
        return <String, dynamic>{
          'uploadId': parameters['uploadId'],
          'url':
              'https://storage.example/rooms/owner-1/'
              '${parameters['roomId']}/${parameters['uploadId']}.jpg',
        };
      };

      final draft = _draftWithImage();
      final repository = _repository(
        firestore: firestore,
        functions: functions,
      );

      await expectLater(
        repository.createRoom(draft),
        throwsA(isA<Exception>()),
      );

      final firstStage = functions.callHistory.firstWhere(
        (entry) => entry.containsKey('stageRoomPhoto'),
      )['stageRoomPhoto']!;
      final firstUploadId = firstStage['uploadId'] as String;

      // The retry must stage the **same** photo object. A fresh upload id
      // would upload the same bytes under a second URL, and the committed
      // photo list would show the photo twice.
      functions.failing.clear();
      await repository.createRoom(draft);

      final stages = functions.callHistory
          .where((entry) => entry.containsKey('stageRoomPhoto'))
          .map((entry) => entry['stageRoomPhoto']!['uploadId'] as String)
          .toList();
      expect(stages.length, 2);
      expect(stages[1], firstUploadId);

      // The commit carries the same upload id as well.
      final commits = functions.callHistory
          .where((entry) => entry.containsKey('commitRoomPhotoChanges'))
          .map((entry) => entry['commitRoomPhotoChanges']!['uploadIds'])
          .toList();
      expect(commits.length, 2);
      expect(commits[1], commits[0]);
    });

    test('a retry which changes the home starts a new listing', () async {
      final firestore = _FakeFirestore();
      final functions = _RecordingFunctionsService();
      // The private location and the cleanup of the incomplete listing both
      // fail, so the attempt stays pending.
      functions.failing.add('setRoomPrivateLocation');
      functions.failing.add('deleteRoomListing');
      final repository = _repository(
        firestore: firestore,
        functions: functions,
      );

      await expectLater(
        repository.createRoom(_draft()),
        throwsA(isA<Exception>()),
      );
      final firstRoomId = firestore.writes.single;

      // The owner picks another home for the listing. The home is persisted
      // with the listing, so the retry must not be folded into the earlier
      // attempt: it would keep the previous home on the listing.
      functions.failing.clear();
      final changed = _draft(
        room: _draft().room.copyWith(homeId: 'home-2', homeName: 'Second home'),
      );
      final secondRoomId = await repository.createRoom(changed);

      expect(secondRoomId, isNot(firstRoomId));
    });

    test(
      'a retry which keeps the same home completes the same listing',
      () async {
        final firestore = _FakeFirestore();
        final functions = _RecordingFunctionsService();
        // The private location and the cleanup of the incomplete listing both
        // fail, so the attempt stays pending.
        functions.failing.add('setRoomPrivateLocation');
        functions.failing.add('deleteRoomListing');
        final repository = _repository(
          firestore: firestore,
          functions: functions,
        );

        // The home id of a **new** home is generated once per form session, so
        // the retry of the same form carries the same id.
        final draft = _draft(
          room: _draft().room.copyWith(
            homeId: 'HOME-1',
            homeName: 'Sunrise Apartments',
          ),
        );

        await expectLater(
          repository.createRoom(draft),
          throwsA(isA<Exception>()),
        );
        final firstRoomId = firestore.writes.single;

        functions.failing.clear();
        final roomId = await repository.createRoom(draft);

        // The same home keeps the same attempt key, so the retry completes the
        // listing of the first attempt instead of publishing a second one.
        expect(roomId, firstRoomId);
        expect(firestore.drafts.length, 1);
        expect(firestore.drafts[roomId]?['homeId'], 'HOME-1');
      },
    );
  });

  group('a rejected owner edit changes nothing', () {
    test(
      'a capacity below the number of tenants is refused before any write',
      () async {
        final firestore = _FakeFirestore();
        final functions = _RecordingFunctionsService();
        firestore.rooms['room-1'] = <String, dynamic>{
          'roomId': 'room-1',
          'ownerId': 'owner-1',
          'currentOccupancy': 2,
          'status': 'available',
        };

        final draft = _draft();
        final occupiedRoom = draft.room.copyWith(
          roomId: 'room-1',
          ownerId: 'owner-1',
          occupancy: 1,
        );

        await expectLater(
          _repository(firestore: firestore, functions: functions).updateRoom(
            RoomDraft(
              room: occupiedRoom,
              privateLocation: draft.privateLocation,
            ),
          ),
          throwsA(isA<Exception>()),
        );

        // Neither the location nor the photos were touched.
        expect(functions.calls, isEmpty);
        expect(firestore.writes, isEmpty);
      },
    );

    test(
      'a tenant who moves in during the edit refuses the whole edit',
      () async {
        final firestore = _FakeFirestore();
        final functions = _RecordingFunctionsService();
        firestore.rooms['room-1'] = <String, dynamic>{
          'roomId': 'room-1',
          'ownerId': 'owner-1',
          'currentOccupancy': 0,
          'status': 'available',
        };

        // The pre-flight read sees an empty room. A tenant moves in right
        // afterwards, so the transactional validation sees a full room.
        var reads = 0;
        firestore.afterGet = (id) {
          reads += 1;
          if (reads != 1) return;
          firestore.rooms[id] = <String, dynamic>{
            ...firestore.rooms[id]!,
            'currentOccupancy': 2,
          };
        };

        final draft = _draft();
        final occupiedRoom = draft.room.copyWith(
          roomId: 'room-1',
          ownerId: 'owner-1',
          occupancy: 1,
        );

        await expectLater(
          _repository(firestore: firestore, functions: functions).updateRoom(
            RoomDraft(
              room: occupiedRoom,
              privateLocation: draft.privateLocation,
            ),
          ),
          throwsA(isA<Exception>()),
        );

        // The capacity was validated before the location and the photos
        // were written, so the rejected edit changed nothing at all.
        expect(functions.calls, isNot(contains('setRoomPrivateLocation')));
        expect(functions.calls, isNot(contains('commitRoomPhotoChanges')));
        expect(firestore.writes, isEmpty);
      },
    );
  });
}
