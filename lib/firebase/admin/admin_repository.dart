import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/constants/app_constants.dart';
import '../../core/constants/enums.dart';
import '../../core/utils/app_logger.dart';
import '../../models/user_model.dart';
import '../../models/room_model.dart';
import '../../models/join_request_model.dart';
import '../../models/launch_pincode_config.dart';
import '../auth/auth_service.dart';

final adminRepositoryProvider = Provider<AdminRepository>((ref) {
  return AdminRepository(
    firestore: ref.watch(firestoreProvider),
    functions: FirebaseFunctions.instance,
    auth: ref.watch(firebaseAuthProvider),
  );
});

/// The server's explicit outcome of an immediate account-deletion request.
///
/// A successful callable call does **not** necessarily mean the account was
/// removed immediately. The deletion may be blocked by active booking data
/// or it may have to be retried after a transient Storage/Firestore failure.
/// The UI keeps those states distinct so an administrator is never told
/// that an account was deleted when it is still queued.
class AccountDeletionResult {
  final bool completed;
  final bool queued;
  final bool blocked;
  final bool retryable;
  final String state;
  final String message;

  const AccountDeletionResult({
    required this.completed,
    required this.queued,
    required this.blocked,
    required this.retryable,
    required this.state,
    required this.message,
  });

  factory AccountDeletionResult.fromData(Map<String, dynamic> data) {
    final state = (data['state'] as String? ?? '').trim().toLowerCase();
    final completed = data['completed'] == true || state == 'completed';
    final blocked = data['blocked'] == true || state == 'blocked';
    final queued =
        data['queued'] == true ||
        state == 'queued' ||
        state == 'blocked' ||
        (!completed && !blocked);
    final retryable = data['retryable'] is bool
        ? data['retryable'] as bool
        : !completed && !blocked;

    return AccountDeletionResult(
      completed: completed,
      queued: queued,
      blocked: blocked,
      retryable: retryable,
      state: state.isEmpty ? (completed ? 'completed' : 'queued') : state,
      message: (data['message'] as String? ?? '').trim(),
    );
  }
}

class AdminRepository {
  final FirebaseFirestore _firestore;
  final FirebaseFunctions _functions;
  final FirebaseAuth _auth;

  AdminRepository({
    required this._firestore,
    required this._functions,
    required this._auth,
  });

  // ============ CLOUD FUNCTION HELPERS ============
  //
  // These used to swallow their errors, which meant the admin UI reported
  // "success" even when the ban / deletion / role change had not happened
  // at all. They now re-throw, so the screen can show the real error.

  Future<void> _callRevokeTokens(String uid) async {
    try {
      final callable = _functions.httpsCallable('revokeUserTokens');
      await callable.call({'uid': uid});
    } catch (e) {
      AppLogger.warning('Cloud Function revokeUserTokens failed', error: e);
      throw Exception(_readableError(e, 'Could not deactivate the user'));
    }
  }

  Future<void> _callSetUserRole(String uid, UserRole role) async {
    try {
      final callable = _functions.httpsCallable('setUserRole');
      await callable.call({'uid': uid, 'role': role.value});
    } catch (e) {
      AppLogger.warning('Cloud Function setUserRole failed', error: e);
      throw Exception(_readableError(e, 'Could not change the role'));
    }
  }

  Future<void> _callBanUser(String uid, {String? reason}) async {
    try {
      final callable = _functions.httpsCallable('banUser');
      await callable.call({'uid': uid, 'reason': reason});
    } catch (e) {
      AppLogger.warning('Cloud Function banUser failed', error: e);
      throw Exception(_readableError(e, 'Could not ban the user'));
    }
  }

  Future<void> _callUnbanUser(String uid) async {
    try {
      final callable = _functions.httpsCallable('unbanUser');
      await callable.call({'uid': uid});
    } catch (e) {
      AppLogger.warning('Cloud Function unbanUser failed', error: e);
      throw Exception(_readableError(e, 'Could not unban the user'));
    }
  }

  Future<AccountDeletionResult> _callDeleteUser(String uid) async {
    try {
      final callable = _functions.httpsCallable('deleteUserCompletely');
      final response = await callable.call({'uid': uid});
      final raw = response.data;
      if (raw is! Map) {
        throw Exception('The deletion response was invalid');
      }
      return AccountDeletionResult.fromData(Map<String, dynamic>.from(raw));
    } catch (e) {
      AppLogger.warning('Cloud Function deleteUserCompletely failed', error: e);
      throw Exception(_readableError(e, 'Could not delete the user'));
    }
  }

  /// Schedules the deletion of an account — with a grace period.
  ///
  /// The account is **not** deleted right away: the user gets
  /// [days] (seven by default) to change their mind, and the admin can
  /// cancel the deletion in the meantime. The account is disabled
  /// immediately, so nobody can use it while the clock is running.
  Future<void> scheduleUserDeletion(String uid, {int days = 7}) async {
    try {
      final callable = _functions.httpsCallable('scheduleUserDeletion');
      await callable.call({'uid': uid, 'days': days});
    } catch (e) {
      AppLogger.warning('Cloud Function scheduleUserDeletion failed', error: e);
      throw Exception(
        _readableError(e, 'Could not schedule the deletion of the account'),
      );
    }
  }

  /// Cancels a scheduled deletion and re-enables the account.
  Future<void> cancelUserDeletion(String uid) async {
    try {
      final callable = _functions.httpsCallable('cancelUserDeletion');
      await callable.call({'uid': uid});
    } catch (e) {
      AppLogger.warning('Cloud Function cancelUserDeletion failed', error: e);
      throw Exception(
        _readableError(e, 'Could not cancel the deletion of the account'),
      );
    }
  }

  /// Turns a `FirebaseFunctionsException` into the message the admin sees.
  static String _readableError(Object error, String fallback) {
    if (error is FirebaseFunctionsException) {
      final message = error.message;
      if (message != null && message.trim().isNotEmpty) return message.trim();
    }
    if (error is Exception) {
      final text = error.toString().replaceFirst('Exception: ', '').trim();
      if (text.isNotEmpty) return text;
    }
    return fallback;
  }

  // ============ USER MANAGEMENT ============

  Stream<List<UserModel>> watchAllUsers({UserRole? roleFilter}) {
    Query<Map<String, dynamic>> query = _firestore
        .collection('users')
        .orderBy('createdAt', descending: true);
    if (roleFilter != null) {
      query = query.where('role', isEqualTo: roleFilter.value);
    }
    return query.snapshots().map(
      (snapshot) => snapshot.docs
          .map((doc) {
            // One malformed user document must not break the whole list.
            try {
              return UserModel.fromJson(doc.data());
            } catch (_) {
              return null;
            }
          })
          .whereType<UserModel>()
          .toList(),
    );
  }

  Future<UserModel?> getUser(String uid) async {
    final doc = await _firestore.collection('users').doc(uid).get();
    if (doc.exists) {
      return UserModel.fromJson(doc.data()!);
    }
    return null;
  }

  Future<void> toggleUserActive(String uid, bool isActive) async {
    if (!isActive) {
      // The cloud function revokes the refresh tokens *and* sets
      // `isActive: false`. It is called first so that a failure cannot leave
      // a "deactivated" user with a live session.
      await _callRevokeTokens(uid);
      return;
    }

    // Reactivation has to go through the backend as well. Writing
    // `isActive: true` directly left the Firebase Auth account disabled, so
    // the profile looked active while the user still could not sign in.
    await _callUnbanUser(uid);
  }

  Future<void> updateUserRole(String uid, UserRole newRole) async {
    // The `setUserRole` cloud function writes the Firestore profile **and**
    // the custom claims, so the two never drift apart. The client used to
    // write the profile first and then call the function — if the call
    // failed, the profile said `admin` while the token still said
    // `student`.
    await _callSetUserRole(uid, newRole);

    // When an admin changes their *own* role the token has to be refreshed,
    // otherwise the server keeps seeing the old claim.
    if (_auth.currentUser?.uid == uid) {
      await _auth.currentUser?.getIdToken(true);
    }
  }

  Future<void> banUser(String uid, {String? reason}) async {
    await _callBanUser(uid, reason: reason);
  }

  Future<void> unbanUser(String uid) async {
    await _callUnbanUser(uid);
  }

  Future<void> deleteUser(String uid) async {
    // Use Cloud Function for complete deletion (Auth + Firestore).
    // Callers which need to distinguish "completed", "blocked" and
    // "queued for retry" use [deleteUserWithResult] instead.
    await _callDeleteUser(uid);
  }

  /// Deletes an account and returns the server's explicit deletion state.
  Future<AccountDeletionResult> deleteUserWithResult(String uid) async {
    return _callDeleteUser(uid);
  }

  // ============ ROOM MANAGEMENT ============

  /// Every listing, optionally filtered by status.
  ///
  /// The status filter is applied **in Dart**, not in the query: a Firestore
  /// equality query never matches a document that does not have the field,
  /// so a listing whose `status` is missing (an older document) would be
  /// invisible in the admin list even though it is a valid listing.
  Stream<List<RoomModel>> watchAllRooms({RoomStatus? statusFilter}) {
    return _firestore
        .collection('rooms')
        .orderBy('createdAt', descending: true)
        .snapshots()
        .map((snapshot) {
          var rooms = snapshot.docs
              .map((doc) {
                try {
                  return RoomModel.fromJson(doc.data(), documentId: doc.id);
                } catch (_) {
                  return null;
                }
              })
              .whereType<RoomModel>()
              .toList();

          if (statusFilter != null) {
            rooms = rooms.where((room) => room.status == statusFilter).toList();
          }
          return rooms;
        });
  }

  Future<void> updateRoomStatus(String roomId, RoomStatus status) async {
    try {
      final callable = _functions.httpsCallable('adminSetRoomListingStatus');
      await callable.call({'roomId': roomId, 'status': status.value});
    } catch (e) {
      AppLogger.warning(
        'Cloud Function adminSetRoomListingStatus failed',
        error: e,
      );
      throw Exception(_readableError(e, 'Could not change the room status'));
    }
  }

  Future<void> deleteRoom(String roomId) async {
    try {
      final callable = _functions.httpsCallable('deleteRoomListing');
      await callable.call({'roomId': roomId});
    } catch (e) {
      AppLogger.warning('Cloud Function deleteRoomListing failed', error: e);
      throw Exception(_readableError(e, 'Could not delete the room'));
    }
  }

  // ============ JOIN REQUEST MANAGEMENT ============

  Stream<List<JoinRequestModel>> watchAllJoinRequests({
    JoinRequestStatus? statusFilter,
  }) {
    Query<Map<String, dynamic>> query = _firestore
        .collection('joinRequests')
        .orderBy('createdAt', descending: true);
    if (statusFilter != null) {
      query = query.where('status', isEqualTo: statusFilter.value);
    }
    return query.snapshots().map(
      (snapshot) => snapshot.docs
          .map((doc) {
            try {
              return JoinRequestModel.fromJson(doc.data());
            } catch (_) {
              return null;
            }
          })
          .whereType<JoinRequestModel>()
          .toList(),
    );
  }

  /// The **most recent** booking requests, together with the room and the
  /// student they belong to.
  ///
  /// The dashboard shows them as a table of rows: an admin wants to see
  /// *what* happened ("Sunita booked "Sunny PG" — waiting for the owner"),
  /// not a list of ids. The rooms and the students are fetched in one go,
  /// so the dashboard does not have to watch the whole database.
  Stream<List<AdminRecentRequest>> watchRecentRequests({int limit = 4}) {
    return _firestore
        .collection('joinRequests')
        .orderBy('createdAt', descending: true)
        .limit(limit)
        .snapshots()
        .asyncMap((snapshot) async {
          final requests = snapshot.docs
              .map((doc) {
                try {
                  return JoinRequestModel.fromJson(doc.data());
                } catch (_) {
                  return null;
                }
              })
              .whereType<JoinRequestModel>()
              .toList();

          if (requests.isEmpty) return <AdminRecentRequest>[];

          final roomIds = requests
              .map((request) => request.roomId)
              .toSet()
              .toList();
          final studentIds = requests
              .map((request) => request.studentId)
              .toSet()
              .toList();

          final rooms = <String, RoomModel>{};
          if (roomIds.isNotEmpty) {
            final roomSnapshot = await _firestore
                .collection('rooms')
                .where(FieldPath.documentId, whereIn: roomIds)
                .get();
            for (final doc in roomSnapshot.docs) {
              try {
                rooms[doc.id] = RoomModel.fromJson(
                  doc.data(),
                  documentId: doc.id,
                );
              } catch (_) {
                // A room that cannot be read is simply shown without a title.
              }
            }
          }

          final students = <String, String>{};
          if (studentIds.isNotEmpty) {
            final userSnapshot = await _firestore
                .collection('users')
                .where(FieldPath.documentId, whereIn: studentIds)
                .get();
            for (final doc in userSnapshot.docs) {
              try {
                final user = UserModel.fromJson(doc.data());
                students[doc.id] = user.name.trim().isEmpty
                    ? doc.id
                    : user.name;
              } catch (_) {
                // A profile that cannot be read is shown as the id.
              }
            }
          }

          return requests
              .map(
                (request) => AdminRecentRequest(
                  request: request,
                  roomTitle: rooms[request.roomId]?.title ?? '',
                  studentName: students[request.studentId] ?? request.studentId,
                ),
              )
              .toList();
        });
  }

  /// Admin reviews (declines) a booking request.
  ///
  /// The review runs on the **server** (`adminReviewRequest`), which re-reads
  /// the request inside a transaction and notifies both the student and the
  /// owner.
  ///
  /// It used to be a Firestore transaction in the app. That had two
  /// problems: the transaction was written by the client (so it could be
  /// tampered with) and it did **not** send a notification — the student
  /// and the owner never heard what happened.
  ///
  /// **A booking is not activated here.** The activation (request, payment,
  /// invoice and occupancy) belongs to `verifyPayment` — the only normal
  /// activation transition. This call is the decline path and the
  /// acknowledgement of a booking that is already active.
  Future<void> adminReviewRequest(
    String requestId, {
    required bool approve,
    String? rejectionReason,
  }) async {
    try {
      final callable = _functions.httpsCallable('adminReviewRequest');
      await callable.call({
        'requestId': requestId,
        'approve': approve,
        'rejectionReason': rejectionReason,
      });
    } catch (e) {
      AppLogger.warning('Cloud Function adminReviewRequest failed', error: e);
      throw Exception(_readableError(e, 'Could not review the request'));
    }
  }

  // ============ INVOICE MANAGEMENT ============

  Stream<List<CommissionInvoiceModel>> watchAllInvoices({
    InvoiceStatus? statusFilter,
  }) {
    Query<Map<String, dynamic>> query = _firestore
        .collection('commissionInvoices')
        .orderBy('createdAt', descending: true);
    if (statusFilter != null) {
      query = query.where('status', isEqualTo: statusFilter.value);
    }
    return query.snapshots().map(
      (snapshot) => snapshot.docs
          .map((doc) {
            try {
              return CommissionInvoiceModel.fromJson(doc.data());
            } catch (_) {
              return null;
            }
          })
          .whereType<CommissionInvoiceModel>()
          .toList(),
    );
  }

  Future<void> markInvoicePaid(
    String invoiceId, {
    String? paymentReference,
    String? paymentMethod,
    String? upiTransactionId,
  }) async {
    await _firestore.collection('commissionInvoices').doc(invoiceId).update({
      'status': InvoiceStatus.paid.value,
      'paidAt': FieldValue.serverTimestamp(),
      'paymentReference': paymentReference,
      'paymentMethod': paymentMethod,
      'upiTransactionId': upiTransactionId,
      'updatedAt': FieldValue.serverTimestamp(),
    });
  }

  Future<void> cancelInvoice(String invoiceId) async {
    await _firestore.collection('commissionInvoices').doc(invoiceId).update({
      'status': InvoiceStatus.cancelled.value,
      'updatedAt': FieldValue.serverTimestamp(),
    });
  }

  // ============ STATISTICS ============

  Future<AdminStats> getStats() async {
    final [
      usersSnap,
      roomsSnap,
      requestsSnap,
      invoicesSnap,
      pendingRequestsSnap,
      pendingInvoicesSnap,
      joinedRoomsSnap,
    ] = await Future.wait([
      _firestore.collection('users').get(),
      _firestore.collection('rooms').get(),
      _firestore.collection('joinRequests').get(),
      _firestore.collection('commissionInvoices').get(),
      _firestore
          .collection('joinRequests')
          .where('status', isEqualTo: JoinRequestStatus.ownerConfirmed.value)
          .get(),
      _firestore
          .collection('commissionInvoices')
          .where('status', isEqualTo: InvoiceStatus.pending.value)
          .get(),
      _firestore
          .collection('joinRequests')
          .where('status', isEqualTo: JoinRequestStatus.adminReviewed.value)
          .get(),
    ]);

    final users = usersSnap.docs
        .map((d) {
          try {
            return UserModel.fromJson(d.data());
          } catch (_) {
            return null;
          }
        })
        .whereType<UserModel>()
        .toList();
    final invoices = invoicesSnap.docs
        .map((d) {
          try {
            return CommissionInvoiceModel.fromJson(d.data());
          } catch (_) {
            return null;
          }
        })
        .whereType<CommissionInvoiceModel>()
        .toList();

    // The revenue is summed as a double and rounded **once** at the end.
    // Rounding every invoice on its own made the books drift downwards.
    var revenue = 0.0;
    for (final inv in invoices) {
      if (inv.isPaid) revenue += inv.commissionAmount;
    }
    final totalRevenue = revenue.round();

    // The listings that are on the market are counted **in Dart**: a
    // Firestore equality query (`status == available`) never matches a
    // document that does not have the field, so a listing without a status
    // would not be counted at all.
    final availableRooms = roomsSnap.docs.where((doc) {
      try {
        return RoomModel.fromJson(doc.data(), documentId: doc.id).status ==
            RoomStatus.available;
      } catch (_) {
        return false;
      }
    }).length;

    return AdminStats(
      totalUsers: usersSnap.size,
      totalStudents: users.where((u) => u.isStudent).length,
      totalOwners: users.where((u) => u.isOwner).length,
      totalRooms: roomsSnap.size,
      availableRooms: availableRooms,
      joinedRooms: joinedRoomsSnap.size,
      pendingConfirmations: pendingRequestsSnap.size,
      pendingInvoices: pendingInvoicesSnap.size,
      totalRevenue: totalRevenue,
    );
  }

  Stream<AdminStats> watchStats() {
    return _firestore
        .collection('users')
        .snapshots()
        .asyncMap((_) => getStats());
  }

  // ============ PLATFORM SETTINGS ============

  Future<void> updateCommissionPercentage(double percentage) async {
    if (percentage < 0 || percentage > 100) {
      throw Exception('The commission has to be between 0 % and 100 %');
    }
    await _firestore.collection('settings').doc('platform').set({
      'commissionPercentage': percentage,
      'updatedAt': FieldValue.serverTimestamp(),
    }, SetOptions(merge: true));
  }

  Future<double> getCommissionPercentage() async {
    final doc = await _firestore.collection('settings').doc('platform').get();
    final value = doc.data()?['commissionPercentage'];
    // 0 % is a valid setting (the platform may waive the fee).
    if (value is num && value >= 0 && value <= 100) {
      return value.toDouble();
    }
    // Falls back to the same default as the payment cloud function and the
    // client, so the slider and the actual charge always agree.
    return AppConstants.platformFeePercentage;
  }

  /// Turns the maintenance mode on or off.
  ///
  /// The flag is written to `publicSettings/platform` — a document that may
  /// be read **without** being signed in, because the splash screen checks
  /// the maintenance mode before the user signs in. It used to be written
  /// to `settings/platform`, which the app never read at all — the switch
  /// looked like it worked but had no effect whatsoever.
  Future<void> setMaintenanceMode(bool enabled) async {
    await _firestore.collection('publicSettings').doc('platform').set({
      'maintenanceMode': enabled,
      'maintenanceMessage': enabled
          ? 'StayServe is under maintenance right now. Please try again in a '
                'little while.'
          : '',
      'updatedAt': FieldValue.serverTimestamp(),
    }, SetOptions(merge: true));
  }

  Future<bool> getMaintenanceMode() async {
    final doc = await _firestore
        .collection('publicSettings')
        .doc('platform')
        .get();
    return doc.data()?['maintenanceMode'] as bool? ?? false;
  }

  /// Whether the platform may send notifications.
  ///
  /// The server honours this flag too, so switching it off really stops the
  /// in-app notifications.
  Future<void> setNotificationsEnabled(bool enabled) async {
    await _firestore.collection('settings').doc('platform').set({
      'notificationsEnabled': enabled,
      'updatedAt': FieldValue.serverTimestamp(),
    }, SetOptions(merge: true));
  }

  Future<bool> getNotificationsEnabled() async {
    final doc = await _firestore.collection('settings').doc('platform').get();
    return doc.data()?['notificationsEnabled'] as bool? ?? true;
  }

  /// Who settles the platform fee of a booking — `owner` or `student`.
  ///
  /// The cut is taken **once**, on the first payment of a booking. When the
  /// owner pays it, the owner is notified when a student books a room and
  /// settles the fee on the platform's own UPI — the owner never has to
  /// upload a UPI of their own. When the student pays it, the student pays
  /// the fee when they confirm the booking.
  Future<void> setFeePayer(String payer) async {
    if (payer != 'owner' && payer != 'student') {
      throw Exception('The fee payer has to be "owner" or "student"');
    }
    await _firestore.collection('settings').doc('platform').set({
      'feePayer': payer,
      'updatedAt': FieldValue.serverTimestamp(),
    }, SetOptions(merge: true));
  }

  Future<String> getFeePayer() async {
    final doc = await _firestore.collection('settings').doc('platform').get();
    final value = doc.data()?['feePayer'];
    if (value == 'owner' || value == 'student') return value as String;
    // The same default as the payment cloud function.
    return 'owner';
  }

  /// Runs one of the server-side maintenance tasks on demand.
  ///
  /// `task` is either `cleanNotifications` or `archiveRooms`.
  Future<String> runMaintenanceTask(String task) async {
    try {
      final callable = _functions.httpsCallable('runMaintenanceTask');
      final result = await callable.call({'task': task});
      final data = Map<String, dynamic>.from(result.data as Map);
      return data['message']?.toString() ?? 'Done';
    } catch (e) {
      AppLogger.warning('Maintenance task failed', error: e);
      throw Exception(_readableError(e, 'The task could not be run'));
    }
  }

  /// The maintenance message the app shows (empty when maintenance is off).
  Future<String> getMaintenanceMessage() async {
    final doc = await _firestore
        .collection('publicSettings')
        .doc('platform')
        .get();
    return doc.data()?['maintenanceMessage'] as String? ?? '';
  }

  // ============ LAUNCH PINCODE CONFIG ============

  /// The launch-area (pincode) configuration.
  ///
  /// It lives in `publicSettings/launch` because it is checked on the very
  /// first launch — before anybody is signed in. A signed-in user cannot
  /// read `settings/launch`, so the check always failed and the gate was
  /// effectively switched off.
  Future<void> updateLaunchPincodeConfig({
    required List<String> enabledPincodes,
    required List<String> disabledPincodes,
    required String mode,
  }) async {
    await _firestore.collection('publicSettings').doc('launch').set({
      'enabledPincodes': enabledPincodes,
      'disabledPincodes': disabledPincodes,
      'mode': mode,
      'updatedAt': FieldValue.serverTimestamp(),
    }, SetOptions(merge: true));
  }

  Future<LaunchPincodeConfig> getLaunchPincodeConfig() async {
    final doc = await _firestore
        .collection('publicSettings')
        .doc('launch')
        .get();
    if (doc.exists) {
      return LaunchPincodeConfig.fromJson(doc.data()!);
    }
    return const LaunchPincodeConfig();
  }

  Stream<LaunchPincodeConfig> watchLaunchPincodeConfig() {
    return _firestore
        .collection('publicSettings')
        .doc('launch')
        .snapshots()
        .map((doc) {
          if (doc.exists) {
            return LaunchPincodeConfig.fromJson(doc.data()!);
          }
          return const LaunchPincodeConfig();
        });
  }

  /// Whether the service may be used from [pincode].
  ///
  /// The comparison normalises the pincode, so "560 001" and "560001" are
  /// treated as the same area.
  Future<bool> isPincodeAllowed(String pincode) async {
    final config = await getLaunchPincodeConfig();
    return config.allows(pincode);
  }
}

class AdminStats {
  final int totalUsers;
  final int totalStudents;
  final int totalOwners;
  final int totalRooms;
  final int availableRooms;
  final int joinedRooms;
  final int pendingConfirmations;
  final int pendingInvoices;
  final int totalRevenue;

  AdminStats({
    required this.totalUsers,
    required this.totalStudents,
    required this.totalOwners,
    required this.totalRooms,
    required this.availableRooms,
    required this.joinedRooms,
    required this.pendingConfirmations,
    required this.pendingInvoices,
    required this.totalRevenue,
  });
}

/// One row of the **recent activity** of the dashboard.
///
/// It carries the request itself plus the names of the room and of the
/// student — an admin wants to read "Sunita booked "Sunny PG"", not a list
/// of ids.
class AdminRecentRequest {
  final JoinRequestModel request;

  /// The title of the room — empty when the room cannot be read.
  final String roomTitle;

  /// The name of the student — the id when the profile cannot be read.
  final String studentName;

  const AdminRecentRequest({
    required this.request,
    required this.roomTitle,
    required this.studentName,
  });

  /// When the request was made.
  DateTime get createdAt => request.createdAt;

  /// The state of the request.
  JoinRequestStatus get status => request.status;

  /// What the room is called — falls back to the id.
  String get roomLabel => roomTitle.isEmpty ? request.roomId : roomTitle;
}
