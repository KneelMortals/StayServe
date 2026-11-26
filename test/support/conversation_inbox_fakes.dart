// A Firestore double for the conversation inbox tests.
//
// The administrator inbox reads two things: the query of the ordinary
// conversations and the exact documents of the support conversations. The
// double below supports exactly those two reads — every other call fails
// loudly, so a test cannot silently pass with the wrong data.
//
// The Firestore types are annotated `@sealed`. That annotation is advisory
// for the analyzer — it only warns that the types are meant to be
// implemented by the package itself — and the double has to implement them
// to be usable at all.
//
// ignore_for_file: subtype_of_sealed_class

import 'dart:async';

import 'package:cloud_firestore/cloud_firestore.dart';

/// The conversations of the double, keyed by their id.
class FakeInboxFirestore implements FirebaseFirestore {
  FakeInboxFirestore();

  /// The support conversations which the double knows.
  final Map<String, Map<String, dynamic>> documents = {};

  final Map<String, StreamController<Map<String, dynamic>?>> _controllers = {};

  @override
  CollectionReference<Map<String, dynamic>> collection(String path) {
    if (path != 'conversations') {
      throw StateError('Unexpected collection: $path');
    }
    return _FakeCollectionReference(this);
  }

  StreamController<Map<String, dynamic>?> _controllerFor(String id) {
    return _controllers.putIfAbsent(
      id,
      () => StreamController<Map<String, dynamic>?>.broadcast(),
    );
  }

  /// Stores a conversation and notifies every watcher of it.
  void putConversation(String id, Map<String, dynamic> data) {
    documents[id] = data;
    _controllerFor(id).add(data);
  }

  /// Removes a conversation and notifies every watcher of it.
  void removeConversation(String id) {
    documents.remove(id);
    _controllerFor(id).add(null);
  }

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw StateError('Firestore is not available in this test');
}

/// The collection of the conversations.
class _FakeCollectionReference
    implements CollectionReference<Map<String, dynamic>> {
  _FakeCollectionReference(this.firestore);

  @override
  final FakeInboxFirestore firestore;

  @override
  String get id => 'conversations';

  @override
  String get path => 'conversations';

  @override
  DocumentReference<Map<String, dynamic>> doc([String? path]) {
    return _FakeDocumentReference(firestore, path ?? '');
  }

  @override
  Query<Map<String, dynamic>> where(
    Object field, {
    Object? isEqualTo,
    Object? isNotEqualTo,
    Object? isLessThan,
    Object? isLessThanOrEqualTo,
    Object? isGreaterThan,
    Object? isGreaterThanOrEqualTo,
    Object? arrayContains,
    Iterable<Object?>? arrayContainsAny,
    Iterable<Object?>? whereIn,
    Iterable<Object?>? whereNotIn,
    bool? isNull,
  }) {
    return _FakeQuery();
  }

  @override
  Query<Map<String, dynamic>> orderBy(Object field, {bool descending = false}) {
    return _FakeQuery();
  }

  @override
  Stream<QuerySnapshot<Map<String, dynamic>>> snapshots({
    bool includeMetadataChanges = false,
    ListenSource source = ListenSource.defaultSource,
  }) {
    // The ordinary conversations are not part of the inbox tests.
    return Stream<QuerySnapshot<Map<String, dynamic>>>.value(
      _FakeQuerySnapshot(const []),
    );
  }

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw StateError('Firestore is not available in this test');
}

/// The query of the ordinary conversations.
class _FakeQuery implements Query<Map<String, dynamic>> {
  @override
  Query<Map<String, dynamic>> where(
    Object field, {
    Object? isEqualTo,
    Object? isNotEqualTo,
    Object? isLessThan,
    Object? isLessThanOrEqualTo,
    Object? isGreaterThan,
    Object? isGreaterThanOrEqualTo,
    Object? arrayContains,
    Iterable<Object?>? arrayContainsAny,
    Iterable<Object?>? whereIn,
    Iterable<Object?>? whereNotIn,
    bool? isNull,
  }) {
    return this;
  }

  @override
  Query<Map<String, dynamic>> orderBy(Object field, {bool descending = false}) {
    return this;
  }

  @override
  Stream<QuerySnapshot<Map<String, dynamic>>> snapshots({
    bool includeMetadataChanges = false,
    ListenSource source = ListenSource.defaultSource,
  }) {
    return Stream<QuerySnapshot<Map<String, dynamic>>>.value(
      _FakeQuerySnapshot(const []),
    );
  }

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw StateError('Firestore is not available in this test');
}

/// The exact document of one conversation.
class _FakeDocumentReference
    implements DocumentReference<Map<String, dynamic>> {
  _FakeDocumentReference(this.firestore, this.id);

  @override
  final FakeInboxFirestore firestore;

  @override
  final String id;

  @override
  String get path => 'conversations/$id';

  @override
  CollectionReference<Map<String, dynamic>> collection(String collectionPath) {
    return firestore.collection(collectionPath);
  }

  @override
  Future<DocumentSnapshot<Map<String, dynamic>>> get([
    GetOptions? options,
  ]) async {
    return _FakeDocumentSnapshot(id, firestore.documents[id]);
  }

  @override
  Stream<DocumentSnapshot<Map<String, dynamic>>> snapshots({
    bool includeMetadataChanges = false,
    ListenSource source = ListenSource.defaultSource,
  }) {
    return Stream<DocumentSnapshot<Map<String, dynamic>>>.multi((multi) {
      void emit() {
        multi.add(_FakeDocumentSnapshot(id, firestore.documents[id]));
      }

      emit();
      final subscription = firestore._controllerFor(id).stream.listen((_) {
        emit();
      });
      multi.onCancel = subscription.cancel;
    });
  }

  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw StateError('Firestore is not available in this test');
}

/// A snapshot of one conversation.
class _FakeDocumentSnapshot implements DocumentSnapshot<Map<String, dynamic>> {
  _FakeDocumentSnapshot(this.id, this._data);

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

/// A snapshot of a query.
class _FakeQuerySnapshot implements QuerySnapshot<Map<String, dynamic>> {
  _FakeQuerySnapshot(this.docs);

  @override
  final List<QueryDocumentSnapshot<Map<String, dynamic>>> docs;

  @override
  int get size => docs.length;

  @override
  SnapshotMetadata get metadata => _FakeSnapshotMetadata();

  @override
  List<DocumentChange<Map<String, dynamic>>> get docChanges => const [];
}

/// The metadata of a snapshot.
class _FakeSnapshotMetadata implements SnapshotMetadata {
  @override
  bool get hasPendingWrites => false;

  @override
  bool get isFromCache => false;
}
