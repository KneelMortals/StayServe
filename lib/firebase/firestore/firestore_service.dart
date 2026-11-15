import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../auth/auth_service.dart';

final firestoreServiceProvider = Provider<FirestoreService>((ref) {
  return FirestoreService(ref.watch(firestoreProvider));
});

class FirestoreService {
  final FirebaseFirestore _firestore;

  FirestoreService(this._firestore);

  // Generic CRUD
  Future<void> setData({
    required String collection,
    required String docId,
    required Map<String, dynamic> data,
    bool merge = false,
  }) async {
    await _firestore.collection(collection).doc(docId).set(data, SetOptions(merge: merge));
  }

  Future<void> updateData({
    required String collection,
    required String docId,
    required Map<String, dynamic> data,
  }) async {
    await _firestore.collection(collection).doc(docId).update(data);
  }

  Future<void> deleteData({
    required String collection,
    required String docId,
  }) async {
    await _firestore.collection(collection).doc(docId).delete();
  }

  Future<DocumentSnapshot> getDocument({
    required String collection,
    required String docId,
  }) async {
    return await _firestore.collection(collection).doc(docId).get();
  }

  Stream<DocumentSnapshot> watchDocument({
    required String collection,
    required String docId,
  }) {
    return _firestore.collection(collection).doc(docId).snapshots();
  }

  Future<QuerySnapshot> getCollection({
    required String collection,
    Query Function(Query)? queryBuilder,
    int? limit,
  }) async {
    Query query = _firestore.collection(collection);
    if (queryBuilder != null) {
      query = queryBuilder(query);
    }
    if (limit != null) {
      query = query.limit(limit);
    }
    return await query.get();
  }

  Stream<QuerySnapshot> watchCollection({
    required String collection,
    Query Function(Query)? queryBuilder,
    int? limit,
  }) {
    Query query = _firestore.collection(collection);
    if (queryBuilder != null) {
      query = queryBuilder(query);
    }
    if (limit != null) {
      query = query.limit(limit);
    }
    return query.snapshots();
  }

  // Batch operations
  WriteBatch batch() => _firestore.batch();

  Future<void> commitBatch(WriteBatch batch) => batch.commit();

  // Transaction
  Future<T> runTransaction<T>(Future<T> Function(Transaction) transactionHandler) {
    return _firestore.runTransaction(transactionHandler);
  }

  // Server timestamp
  FieldValue get serverTimestamp => FieldValue.serverTimestamp();

  // Increment
  FieldValue increment(num value) => FieldValue.increment(value);

  // Array operations
  FieldValue arrayUnion(List values) => FieldValue.arrayUnion(values);
  FieldValue arrayRemove(List values) => FieldValue.arrayRemove(values);
}