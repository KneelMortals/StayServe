import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../models/notification_model.dart';
import '../auth/auth_service.dart';
import '../functions/functions_service.dart';

final notificationsRepositoryProvider = Provider<NotificationsRepository>((
  ref,
) {
  return NotificationsRepository(
    firestore: ref.watch(firestoreProvider),
    auth: ref.watch(firebaseAuthProvider),
    functions: ref.watch(functionsServiceProvider),
  );
});

/// Data access for the notifications collection.
class NotificationsRepository {
  final FirebaseFirestore _firestore;
  final FirebaseAuth _auth;
  final FunctionsService _functions;

  NotificationsRepository({
    required this._firestore,
    required this._auth,
    required this._functions,
  });

  String? get _uid => _auth.currentUser?.uid;

  /// Notifications addressed to the current user, newest first.
  Stream<List<NotificationModel>> watchNotifications() {
    final uid = _uid;
    if (uid == null) return Stream.value([]);

    return _firestore
        .collection('notifications')
        .where('userId', isEqualTo: uid)
        .orderBy('createdAt', descending: true)
        .limit(100)
        .snapshots()
        .map(
          (snapshot) => snapshot.docs
              .map((doc) => _parse(doc))
              .whereType<NotificationModel>()
              .toList(),
        );
  }

  /// Marks a single notification as read.
  Future<void> markAsRead(String notificationId) async {
    await _firestore.collection('notifications').doc(notificationId).update({
      'read': true,
      'readAt': FieldValue.serverTimestamp(),
    });
  }

  /// Marks every notification of the current user as read.
  Future<void> markAllAsRead() async {
    final uid = _uid;
    if (uid == null) return;

    final snapshot = await _firestore
        .collection('notifications')
        .where('userId', isEqualTo: uid)
        .where('read', isEqualTo: false)
        .get();

    if (snapshot.docs.isEmpty) return;

    final batch = _firestore.batch();
    for (final doc in snapshot.docs) {
      batch.update(doc.reference, {
        'read': true,
        'readAt': FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
  }

  /// Deletes a notification.
  ///
  /// The backend verifies that the notification belongs to the caller. The
  /// Firestore rules deliberately do not allow clients to delete notification
  /// documents directly.
  Future<void> deleteNotification(String notificationId) async {
    await _functions.callVoidFunction(
      'deleteNotification',
      parameters: {'notificationId': notificationId},
      fallbackMessage: 'Could not delete the notification',
    );
  }

  /// The number of unread notifications.
  Stream<int> watchUnreadCount() {
    final uid = _uid;
    if (uid == null) return Stream.value(0);

    return _firestore
        .collection('notifications')
        .where('userId', isEqualTo: uid)
        .where('read', isEqualTo: false)
        .snapshots()
        .map((snapshot) => snapshot.docs.length);
  }

  NotificationModel? _parse(DocumentSnapshot<Map<String, dynamic>> doc) {
    final data = doc.data();
    if (data == null) return null;
    try {
      return NotificationModel.fromJson({
        ...data,
        'notificationId': doc.id,
        'userId': data['userId'] ?? '',
        'type': data['type'] ?? 'general',
        'title': data['title'] ?? '',
        'body': data['body'] ?? '',
        'data': data['data'] ?? const {},
        'createdAt': data['createdAt'],
        'readAt': data['readAt'],
        'sent': data['sent'] ?? false,
      });
    } catch (_) {
      return null;
    }
  }
}
