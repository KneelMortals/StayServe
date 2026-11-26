import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/constants/enums.dart';
import '../../models/join_request_model.dart';
import '../auth/auth_service.dart';
import '../functions/functions_service.dart';

typedef JoinRequestCallable =
    Future<Map<String, dynamic>> Function(
      String name, {
      Map<String, dynamic>? parameters,
    });

typedef JoinRequestDocumentReader =
    Future<Map<String, dynamic>?> Function(String requestId);

final studentJoinRequestProvider = Provider<StudentJoinRequestRepository>((
  ref,
) {
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
  final JoinRequestCallable? _callable;
  final JoinRequestDocumentReader? _documentReader;

  StudentJoinRequestRepository({
    required FirebaseFirestore firestore,
    required FirebaseAuth auth,
    required FunctionsService functions,
    JoinRequestCallable? callable,
    JoinRequestDocumentReader? documentReader,
  }) : this._(firestore, auth, functions, callable, documentReader);

  StudentJoinRequestRepository._(
    this._firestore,
    this._auth,
    this._functions,
    this._callable,
    this._documentReader,
  );

  /// Create a join request for a room (student initiates)
  ///
  /// The document is written by the **server**: it reads the room itself, so
  /// the owner, the rent and the platform-fee percentage cannot be forged by
  /// a modified client (which used to mean a student could pay a fee of
  /// almost nothing, or approve their own request).
  ///
  /// The returned model is read from the canonical server-owned document.
  /// A missing document or an identity mismatch fails closed; the client
  /// never synthesises a request which could look authoritative in the UI.
  Future<JoinRequestModel> createJoinRequest({required String roomId}) async {
    final user = _auth.currentUser;
    if (user == null) throw Exception('User not logged in');

    final data =
        await (_callable?.call(
              'createJoinRequest',
              parameters: <String, dynamic>{'roomId': roomId},
            ) ??
            _functions.callFunctionData(
              'createJoinRequest',
              parameters: <String, dynamic>{'roomId': roomId},
            ));
    if (data['success'] != true) {
      throw StateError('Booking request creation was not confirmed.');
    }

    final requestId = data['requestId']?.toString().trim() ?? '';
    if (requestId.isEmpty) {
      throw StateError('Booking request id missing from server response.');
    }

    // The server writes the document; this read picks it up again so the
    // caller gets the real model (rent, owner, status).
    Map<String, dynamic>? canonical;
    if (_documentReader != null) {
      canonical = await _documentReader(requestId);
    } else {
      final snapshot = await _firestore
          .collection('joinRequests')
          .doc(requestId)
          .get();
      canonical = snapshot.exists ? snapshot.data() : null;
    }
    if (canonical == null) {
      throw StateError('Booking request could not be read from the server.');
    }

    final canonicalRequestId = canonical['requestId']?.toString().trim() ?? '';
    final canonicalRoomId = canonical['roomId']?.toString().trim() ?? '';
    final canonicalStudentId = canonical['studentId']?.toString().trim() ?? '';
    final canonicalOwnerId = canonical['ownerId']?.toString().trim() ?? '';
    final canonicalStatus = canonical['status']?.toString().trim() ?? '';
    final statusIsKnown = JoinRequestStatus.values.any(
      (status) => status.name == canonicalStatus,
    );
    if (canonicalRequestId != requestId ||
        canonicalRoomId != roomId ||
        canonicalStudentId != user.uid ||
        canonicalOwnerId.isEmpty ||
        canonicalOwnerId == canonicalStudentId ||
        !statusIsKnown) {
      throw StateError(
        'Booking request identity does not match the server response.',
      );
    }

    return JoinRequestModel.fromJson(canonical);
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
        if (reason != null && reason.trim().isNotEmpty) 'reason': reason.trim(),
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
        .map(
          (snapshot) => snapshot.docs
              .map((doc) => JoinRequestModel.fromJson(doc.data()))
              .toList(),
        );
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
        .where(
          'status',
          whereIn: [
            JoinRequestStatus.pending.value,
            JoinRequestStatus.studentConfirmed.value,
          ],
        )
        .orderBy('createdAt', descending: true)
        .snapshots()
        .map(
          (snapshot) => snapshot.docs
              .map((doc) => JoinRequestModel.fromJson(doc.data()))
              .toList(),
        );
  }
}
