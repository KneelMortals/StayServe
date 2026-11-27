// Regression tests for the room-photo retry of an owner edit.
//
// A server call can commit even when its acknowledgement never reaches the
// client. The owner repository therefore keeps the staged upload ids of an
// unconfirmed edit and stages the **same** photos again on the next attempt.
// The server returns the same download URL for an upload id it already knows
// with the same bytes, so the committed photo list cannot show one photo
// twice.
//
// The Firestore and the Cloud Functions types are annotated `@sealed`. That
// annotation is advisory for the analyzer — it only warns that the types are
// meant to be implemented by the package itself — and the doubles have to
// implement them to be usable at all.
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

/// A callable failure which carries the server's error code.
class _TestFunctionsException extends FirebaseFunctionsException {
  _TestFunctionsException({required super.message, required super.code});
}

class _FakeCallableResult implements HttpsCallableResult<dynamic> {
  _FakeCallableResult(this.data);

  @override
  final dynamic data;

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

/// A Firestore double for the room collections.
class _FakeFirestore implements FirebaseFirestore {
  /// The stored published listings, keyed by their id.
  final Map<String, Map<String, dynamic>> rooms =
      <String, Map<String, dynamic>>{};

  /// The stored draft listings, keyed by their id.
  final Map<String, Map<String, dynamic>> drafts =
      <String, Map<String, dynamic>>{};

  Map<String, Map<String, dynamic>> _storeOf(String path) {
    if (path == 'rooms') return rooms;
    if (path == 'roomDrafts') return drafts;
    throw StateError('Unexpected collection: $path');
  }

  @override
  CollectionReference<Map<String, dynamic>> collection(String path) {
    _storeOf(path);
    return _FakeCollection(this, path);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw StateError('Firestore is not available in this test');
}

class _FakeCollection implements CollectionReference<Map<String, dynamic>> {
  _FakeCollection(this.firestore, this.collectionPath);

  @override
  final _FakeFirestore firestore;

  /// The collection which this reference addresses.
  final String collectionPath;

  @override
  String get id => collectionPath;

  @override
  String get path => collectionPath;

  @override
  DocumentReference<Map<String, dynamic>> doc([String? path]) =>
      _FakeDocument(firestore, collectionPath, path ?? '');

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class _FakeDocument implements DocumentReference<Map<String, dynamic>> {
  _FakeDocument(this.firestore, this.collectionPath, this.id);

  @override
  final _FakeFirestore firestore;

  /// The collection which this document belongs to.
  final String collectionPath;

  @override
  final String id;

  @override
  String get path => '$collectionPath/$id';

  @override
  CollectionReference<Map<String, dynamic>> collection(String collectionPath) =>
      firestore.collection(collectionPath);

  @override
  Future<DocumentSnapshot<Map<String, dynamic>>> get([
    GetOptions? options,
  ]) async {
    final store = collectionPath == 'rooms'
        ? firestore.rooms
        : firestore.drafts;
    return _FakeSnapshot(id, store[id]);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

class _FakeSnapshot implements DocumentSnapshot<Map<String, dynamic>> {
  _FakeSnapshot(this.id, this._data);

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

/// One staged upload of the fake server.
class _FakeUpload {
  _FakeUpload({required this.data, required this.url});

  /// The base64 bytes which were staged.
  final String data;

  /// The download URL of the staged object.
  final String url;

  /// The server-side status of the upload.
  ///
  /// The server keeps the record of a discarded upload and refuses a later
  /// re-use of it, so the status mirrors that behaviour.
  String status = 'uploaded';
}

/// A model of the server-side room-photo behaviour.
///
/// The real server keeps a durable upload record per upload id. It returns
/// the same download URL when the same id is staged again with the same
/// bytes and it refuses a re-use whose bytes changed. The commit attaches
/// the staged URLs to the listing, drops the URLs the owner removed and
/// never lists one URL twice. The model reproduces exactly those rules, so
/// the client-side retry is tested against them.
class _FakeRoomMediaServer {
  _FakeRoomMediaServer(this.firestore);

  final _FakeFirestore firestore;

  /// The staged uploads, keyed by their upload id.
  final Map<String, _FakeUpload> uploads = <String, _FakeUpload>{};

  /// The number of committed room-photo updates.
  int commitCount = 0;

  /// The number of `updateRoomListing` calls which commit but whose
  /// acknowledgement never reaches the client.
  int lostAcknowledgements = 0;

  /// The number of `updateRoomListing` calls which are rejected outright.
  int rejectedCommits = 0;

  /// When set, a re-use of an upload id is refused with this message.
  String? refuseReuseWithMessage;

  /// The ids of the staged uploads, in the order they were staged.
  final List<String> stagedUploadIds = <String>[];

  Map<String, dynamic> stageRoomPhoto(Map<String, dynamic> parameters) {
    final roomId = parameters['roomId'] as String;
    final uploadId = parameters['uploadId'] as String;
    final data = parameters['data'] as String;
    final existing = uploads[uploadId];
    if (existing != null) {
      if (refuseReuseWithMessage != null) {
        throw _TestFunctionsException(
          message: refuseReuseWithMessage!,
          code: 'failed-precondition',
        );
      }
      if (existing.status == 'cleaned') {
        // The server keeps the record of a discarded upload and refuses a
        // later re-use of it.
        throw _TestFunctionsException(
          message: 'That upload can no longer be retried.',
          code: 'failed-precondition',
        );
      }
      if (existing.data != data) {
        throw _TestFunctionsException(
          message: 'That upload id was already used for different photo data.',
          code: 'failed-precondition',
        );
      }
      // The server knows the upload id: the same bytes return the same URL.
      return <String, dynamic>{'uploadId': uploadId, 'url': existing.url};
    }

    final url =
        'https://storage.test/rooms/owner-1/$roomId/$uploadId?token=$uploadId';
    uploads[uploadId] = _FakeUpload(data: data, url: url);
    stagedUploadIds.add(uploadId);
    return <String, dynamic>{'uploadId': uploadId, 'url': url};
  }

  void updateRoomListing(Map<String, dynamic> parameters) {
    if (rejectedCommits > 0) {
      rejectedCommits -= 1;
      throw Exception('The callable updateRoomListing failed.');
    }

    final roomId = parameters['roomId'] as String;
    final uploadIds = (parameters['uploadIds'] as List).cast<String>();
    final removeUrls = (parameters['removeUrls'] as List).cast<String>();
    final listing = firestore.rooms[roomId];
    if (listing == null) throw StateError('The listing does not exist.');

    final update = parameters['update'] as Map<String, dynamic>;
    listing['title'] = update['title'];

    final current =
        (listing['images'] as List?)?.cast<String>() ?? const <String>[];
    final images = <String>[];
    for (final url in current) {
      if (removeUrls.contains(url)) continue;
      if (!images.contains(url)) images.add(url);
    }
    for (final uploadId in uploadIds) {
      final upload = uploads[uploadId]!;
      upload.status = 'referenced';
      if (!images.contains(upload.url)) images.add(upload.url);
    }
    listing['images'] = images;
    commitCount += 1;

    if (lostAcknowledgements > 0) {
      lostAcknowledgements -= 1;
      throw Exception('The callable updateRoomListing failed.');
    }
  }

  void discardRoomPhotoUpload(Map<String, dynamic> parameters) {
    final uploadId = parameters['uploadId'] as String;
    final upload = uploads[uploadId];
    if (upload == null) return;
    // The server removes only objects which the live listing does not
    // reference. A committed photo therefore survives the discard.
    for (final listing in <Map<String, dynamic>>[
      ...firestore.rooms.values,
      ...firestore.drafts.values,
    ]) {
      final images =
          (listing['images'] as List?)?.cast<String>() ?? const <String>[];
      if (images.contains(upload.url)) {
        upload.status = 'referenced';
        return;
      }
    }
    upload.status = 'cleaned';
  }
}

/// Records every callable and models the server-side room-photo rules.
class _MediaFunctionsService extends FunctionsService {
  _MediaFunctionsService(this.server) : super(_UnavailableFirebaseFunctions());

  final _FakeRoomMediaServer server;

  final List<String> calls = <String>[];

  /// The parameters of every call, in order.
  final List<Map<String, dynamic>> callHistory = <Map<String, dynamic>>[];

  /// The parameters of the staging calls, in order.
  List<Map<String, dynamic>> get stageCalls => callHistory
      .where((entry) => entry.containsKey('data'))
      .toList(growable: false);

  @override
  Future<HttpsCallableResult> callFunction(
    String name, {
    Map<String, dynamic>? parameters,
  }) async {
    calls.add(name);
    final recorded = Map<String, dynamic>.from(
      parameters ?? const <String, dynamic>{},
    );
    callHistory.add(recorded);
    switch (name) {
      case 'stageRoomPhoto':
        return _FakeCallableResult(server.stageRoomPhoto(recorded));
      case 'updateRoomListing':
        server.updateRoomListing(recorded);
        return _FakeCallableResult(<String, dynamic>{'success': true});
      case 'discardRoomPhotoUpload':
        server.discardRoomPhotoUpload(recorded);
        return _FakeCallableResult(<String, dynamic>{'success': true});
      default:
        throw StateError('Unexpected callable: $name');
    }
  }
}

/// The bytes of the photo which the owner picked.
List<int> _photoBytes({int marker = 0}) => <int>[
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
  marker,
];

RoomDraft _editDraft({List<int>? photoBytes, String title = 'Renamed room'}) {
  final now = DateTime.utc(2026, 1, 1);
  return RoomDraft(
    room: RoomModel(
      roomId: 'room-1',
      ownerId: 'owner-1',
      title: title,
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
      roomId: 'room-1',
      ownerId: 'owner-1',
      address: '42 Test Street',
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560001',
      latitude: 12.9716,
      longitude: 77.5946,
      updatedAt: now,
    ),
    newImages: <XFile>[
      XFile.fromData(
        Uint8List.fromList(photoBytes ?? _photoBytes()),
        name: 'room-photo.jpg',
      ),
    ],
    originalImageUrls: const <String>[],
  );
}

OwnerRepository _repository({
  required _FakeFirestore firestore,
  required _MediaFunctionsService functions,
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

void main() {
  group('the room-photo retry of an owner edit', () {
    test('a lost acknowledgement does not append the photo twice', () async {
      final firestore = _FakeFirestore();
      firestore.rooms['room-1'] = <String, dynamic>{
        'roomId': 'room-1',
        'ownerId': 'owner-1',
        'currentOccupancy': 0,
        'status': 'available',
        'images': <String>[],
      };
      final server = _FakeRoomMediaServer(firestore);
      // The server commits the edit but neither acknowledgement reaches the
      // client.
      server.lostAcknowledgements = 2;
      final functions = _MediaFunctionsService(server);
      final repository = _repository(
        firestore: firestore,
        functions: functions,
      );

      await expectLater(
        repository.updateRoom(_editDraft()),
        throwsA(isA<Exception>()),
      );

      // The edit did commit on the server.
      final afterFirstAttempt = (firestore.rooms['room-1']!['images'] as List)
          .cast<String>();
      expect(afterFirstAttempt, hasLength(1));

      // The owner saves again. The photo must not show up a second time.
      await repository.updateRoom(_editDraft());

      final images = (firestore.rooms['room-1']!['images'] as List)
          .cast<String>();
      expect(images, hasLength(1));
      expect(images.single, afterFirstAttempt.single);

      // The retry staged the very same upload id, so the server returned the
      // same download URL instead of a second one.
      final stages = functions.stageCalls;
      expect(stages, hasLength(2));
      expect(stages[0]['uploadId'], stages[1]['uploadId']);
    });

    test('a changed photo under the same name still succeeds', () async {
      final firestore = _FakeFirestore();
      firestore.rooms['room-1'] = <String, dynamic>{
        'roomId': 'room-1',
        'ownerId': 'owner-1',
        'currentOccupancy': 0,
        'status': 'available',
        'images': <String>[],
      };
      final server = _FakeRoomMediaServer(firestore);
      server.lostAcknowledgements = 2;
      final functions = _MediaFunctionsService(server);
      final repository = _repository(
        firestore: firestore,
        functions: functions,
      );

      await expectLater(
        repository.updateRoom(_editDraft()),
        throwsA(isA<Exception>()),
      );

      // The owner picked a different photo under the same name and the same
      // size. The server refuses the re-use of the upload id, so the photo
      // is staged under a fresh one and the edit succeeds.
      await repository.updateRoom(
        _editDraft(photoBytes: _photoBytes(marker: 1), title: 'Second title'),
      );

      expect(firestore.rooms['room-1']!['title'], 'Second title');
      final stages = functions.stageCalls;
      expect(stages, hasLength(3));
      expect(stages[1]['uploadId'], stages[0]['uploadId']);
      expect(stages[2]['uploadId'], isNot(stages[1]['uploadId']));
    });

    test('an expired upload id is staged under a fresh id', () async {
      final firestore = _FakeFirestore();
      firestore.rooms['room-1'] = <String, dynamic>{
        'roomId': 'room-1',
        'ownerId': 'owner-1',
        'currentOccupancy': 0,
        'status': 'available',
        'images': <String>[],
      };
      final server = _FakeRoomMediaServer(firestore);
      // The first attempt is rejected before it commits. The client retries
      // the commit once, so both attempts are rejected.
      server.rejectedCommits = 2;
      final functions = _MediaFunctionsService(server);
      final repository = _repository(
        firestore: firestore,
        functions: functions,
      );

      await expectLater(
        repository.updateRoom(_editDraft()),
        throwsA(isA<Exception>()),
      );

      // The staged upload was discarded in the meantime. The server refuses
      // the re-use of its upload id and the photo is staged under a fresh
      // one.
      await repository.updateRoom(_editDraft());

      final images = (firestore.rooms['room-1']!['images'] as List)
          .cast<String>();
      expect(images, hasLength(1));
      final stages = functions.stageCalls;
      expect(stages, hasLength(3));
      expect(stages[1]['uploadId'], stages[0]['uploadId']);
      expect(stages[2]['uploadId'], isNot(stages[1]['uploadId']));
    });

    test('an untrusted storage URL is not hidden by a re-upload', () async {
      final firestore = _FakeFirestore();
      firestore.rooms['room-1'] = <String, dynamic>{
        'roomId': 'room-1',
        'ownerId': 'owner-1',
        'currentOccupancy': 0,
        'status': 'available',
        'images': <String>[],
      };
      final server = _FakeRoomMediaServer(firestore);
      server.rejectedCommits = 2;
      final functions = _MediaFunctionsService(server);
      final repository = _repository(
        firestore: firestore,
        functions: functions,
      );

      await expectLater(
        repository.updateRoom(_editDraft()),
        throwsA(isA<Exception>()),
      );

      // An untrusted storage URL is an integrity anomaly, not a refusal of
      // the upload id. The client must not hide it behind a silent re-upload.
      server.refuseReuseWithMessage =
          'The staged photo has an untrusted storage URL.';
      await expectLater(
        repository.updateRoom(_editDraft()),
        throwsA(
          isA<FirebaseFunctionsException>().having(
            (error) => error.message,
            'message',
            contains('untrusted storage URL'),
          ),
        ),
      );

      // Only the first attempt reached the server.
      expect(functions.stageCalls, hasLength(2));
      expect(firestore.rooms['room-1']!['images'], isEmpty);
    });
  });
}
