import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/constants/enums.dart';
import '../../models/join_request_model.dart';
import '../auth/auth_service.dart';
import '../functions/functions_service.dart';

final studentJoinRequestProvider = Provider<StudentJoinRequestRepository>((ref) {
  return StudentJoinRequestRepository(
    firestore: ref.watch(firestoreProvider),
    auth: ref.watch(firebaseAuthProvider),
    functions: ref.watch(functionsServiceProvider),
  );
});

class StudentJoinRequestRepository {
  final FirebaseFirestore _firestore;
  final FirebaseAuth _auth;
  final FunctionsService _functions;

  StudentJoinRequestRepository({
    required this._firestore,
    required this._auth,
    required this._functions,
  });

  /// Create a join request for a room (student initiates)
  ///
  /// The document is written by the **server**: it reads the room itself, so
  /// the owner, the rent and the platform-fee percentage cannot be forged by
  /// a modified client (which used to mean a student could pay a fee of
  /// almost nothing, or approve their own request).
  ///
  /// [ownerId] and [monthlyRent] are kept for backwards compatibility with
  /// the calling screens — the server ignores them.
  Future<JoinRequestModel> createJoinRequest({
    required String roomId,
    String? ownerId,
    double? monthlyRent,
  }) async {
    final user = _auth.currentUser;
    if (user == null) throw Exception('User not logged in');

    final result = await _functions.callFunction(
      'createJoinRequest',
      parameters: {'roomId': roomId},
    );

    final data = Map<String, dynamic>.from(result.data as Map);
    final requestId = data['requestId']?.toString() ?? '';

    // The server writes the document; this read picks it up again so the
    // caller gets the real model (rent, owner, status).
    final snapshot =
        await _firestore.collection('joinRequests').doc(requestId).get();
    if (snapshot.exists) {
      return JoinRequestModel.fromJson(snapshot.data()!);
    }

    return JoinRequestModel(
      requestId: requestId,
      roomId: roomId,
      studentId: user.uid,
      ownerId: ownerId ?? '',
      status: JoinRequestStatus.pending,
      createdAt: DateTime.now(),
      updatedAt: DateTime.now(),
      monthlyRentAtJoin: monthlyRent ?? 0,
      commissionPercentageAtJoin:
          (data['commissionPercentageAtJoin'] as num?)?.toDouble() ?? 0,
    );
  }

  /// Student confirms they want to join (after owner approval) - triggers payment
  Future<void> studentConfirmJoin(String requestId) async {
    await _functions.callFunction(
      'confirmJoinAsStudent',
      parameters: {'requestId': requestId},
    );
  }

  /// Student pays 30% advance via UPI.
  ///
  /// Removed on purpose: the client must never be able to mark its own
  /// advance as paid. The flow is now
  /// `createPaymentIntent` → `submitPayment` (server records the reference)
  /// → `verifyPayment` (admin confirms, and only then is `advancePaid` set).
  /// See `PaymentRepository`.

  /// Cancel join request (student or owner)
  ///
  /// The booking can be walked away from as long as **nothing** was paid for
  /// it — also after the owner accepted it. The server checks that, so the
  /// app cannot cancel a booking that already has money in it.
  Future<void> cancelJoinRequest(String requestId, {String? reason}) async {
    await _functions.callFunction(
      'cancelJoinRequest',
      parameters: {
        'requestId': requestId,
        if (reason != null && reason.trim().isNotEmpty)
          'reason': reason.trim(),
      },
    );
  }

  /// Get student's join requests
  Stream<List<JoinRequestModel>> watchStudentJoinRequests() {
    final user = _auth.currentUser;
    if (user == null) return Stream.value([]);

    return _firestore
        .collection('joinRequests')
        .where('studentId', isEqualTo: user.uid)
        .orderBy('createdAt', descending: true)
        .snapshots()
        .map((snapshot) => snapshot.docs
            .map((doc) => JoinRequestModel.fromJson(doc.data()))
            .toList());
  }

  /// Get pending join requests for a room (owner view)
  ///
  /// The query is constrained to the current owner — a Firestore query has
  /// to *prove* that every document it could return is readable, so an
  /// unconstrained `roomId` query was rejected by the security rules.
  Stream<List<JoinRequestModel>> watchRoomJoinRequests(String roomId) {
    final user = _auth.currentUser;
    if (user == null) return Stream.value([]);

    return _firestore
        .collection('joinRequests')
        .where('roomId', isEqualTo: roomId)
        .where('ownerId', isEqualTo: user.uid)
        .where('status', whereIn: [
      JoinRequestStatus.pending.value,
      JoinRequestStatus.studentConfirmed.value,
    ])
        .orderBy('createdAt', descending: true)
        .snapshots()
        .map((snapshot) => snapshot.docs
            .map((doc) => JoinRequestModel.fromJson(doc.data()))
            .toList());
  }
}