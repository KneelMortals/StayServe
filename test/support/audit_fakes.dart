// Fakes that the button audit uses.
//
// The audit mounts every student / owner / admin screen and taps every
// button on it. The screens talk to Firestore, to the Cloud Functions and
// to the Auth service — none of them exist in a widget test, so every
// repository is replaced by a fake that answers with harmless data.
//
// The fakes are **typed**: every method that the screens call has a real
// override with the right return type, so a wrong call still fails the
// test instead of silently returning `null`.

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_auth_mocks/firebase_auth_mocks.dart';
import 'package:stayserve/core/constants/enums.dart';
import 'package:stayserve/firebase/admin/admin_repository.dart';
import 'package:stayserve/firebase/auth/auth_service.dart';
import 'package:stayserve/firebase/functions/functions_service.dart';
import 'package:stayserve/firebase/messaging/conversation_repository.dart';
import 'package:stayserve/firebase/notifications/notifications_repository.dart';
import 'package:stayserve/firebase/owner/owner_repository.dart';
import 'package:stayserve/firebase/otp/otp_service.dart';
import 'package:stayserve/firebase/payments/payment_repository.dart';
import 'package:stayserve/firebase/reviews/review_repository.dart';
import 'package:stayserve/firebase/student/student_join_request_repository.dart';
import 'package:stayserve/firebase/student/student_repository.dart';
import 'package:stayserve/firebase/visits/visit_repository.dart';
import 'package:stayserve/models/interaction_model.dart';
import 'package:stayserve/models/join_request_model.dart';
import 'package:stayserve/models/messaging_model.dart';
import 'package:stayserve/models/owned_room_model.dart';
import 'package:stayserve/models/payment_model.dart';
import 'package:stayserve/models/room_model.dart';
import 'package:stayserve/models/room_private_location.dart';
import 'package:stayserve/models/room_review_model.dart';
import 'package:stayserve/models/user_model.dart';
import 'package:stayserve/services/location_service.dart';
import 'package:stayserve/features/auth/presentation/providers/auth_provider.dart';
import 'package:stayserve/services/user_location_provider.dart';

// ---------------------------------------------------------------------------
// The Firebase clients — they are only stored, never used.
// ---------------------------------------------------------------------------

class FakeFirestore implements FirebaseFirestore {
  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw StateError('Firestore is not available in the button audit');
}

class FakeFirebaseFunctions implements FirebaseFunctions {
  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw StateError('Cloud Functions are not available in the button audit');
}

/// The result of a callable function.
class FakeCallableResult implements HttpsCallableResult<dynamic> {
  @override
  final dynamic data;

  FakeCallableResult(this.data);

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

/// A functions service that answers every call with an empty map.
class FakeFunctionsService extends FunctionsService {
  FakeFunctionsService() : super(FakeFirebaseFunctions());

  @override
  Future<HttpsCallableResult<dynamic>> callFunction(
    String name, {
    Map<String, dynamic>? parameters,
  }) async {
    return FakeCallableResult(<String, dynamic>{});
  }
}

// ---------------------------------------------------------------------------
// The repositories.
// ---------------------------------------------------------------------------

/// The owner repository — every action succeeds and does nothing.
class FakeOwnerRepository extends OwnerRepository {
  FakeOwnerRepository()
    : super(
        firestore: FakeFirestore(),
        auth: MockFirebaseAuth(),
        functions: FakeFunctionsService(),
      );

  @override
  Future<String> createRoom(RoomDraft draft) async => 'room-1';

  @override
  Future<void> updateRoom(RoomDraft draft) async {}

  @override
  Future<void> setRoomOccupied(String roomId, {required bool occupied}) async {}

  @override
  Future<void> deleteRoom(String roomId) async {}

  @override
  Future<void> confirmRequest(String requestId) async {}

  @override
  Future<void> rejectRequest(String requestId, {String? reason}) async {}

  @override
  Future<void> cancelRequest(String requestId, {String? reason}) async {}
}

/// The student repository.
class FakeStudentRepository extends StudentRepository {
  FakeStudentRepository()
    : super(firestore: FakeFirestore(), auth: MockFirebaseAuth());

  @override
  Future<void> toggleSavedRoom(String roomId) async {}

  @override
  Future<bool> isRoomSaved(String roomId) async => false;
}

/// The repository that creates and cancels join requests.
class FakeStudentJoinRequestRepository extends StudentJoinRequestRepository {
  FakeStudentJoinRequestRepository()
    : super(
        firestore: FakeFirestore(),
        auth: MockFirebaseAuth(),
        functions: FakeFunctionsService(),
      );

  @override
  Future<JoinRequestModel> createJoinRequest({required String roomId}) async {
    return auditRequest();
  }

  @override
  Future<void> studentConfirmJoin(String requestId) async {}

  @override
  Future<void> cancelJoinRequest(String requestId, {String? reason}) async {}
}

/// The repository that hands out the address of an accepted room.
class FakeVisitRepository extends VisitRepository {
  FakeVisitRepository() : super(functions: FakeFunctionsService());

  @override
  Future<RoomVisitDetails> getVisitDetails(String roomId) async {
    return RoomVisitDetails(
      roomId: roomId,
      title: 'Test room',
      address: '42 Test Street',
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560001',
      latitude: 12.9716,
      longitude: 77.5946,
      ownerId: 'owner-1',
      ownerName: 'Test Owner',
      fullAddress: '42 Test Street, Bengaluru, Karnataka 560001',
    );
  }
}

/// The repository that writes the reviews.
class FakeReviewRepository extends ReviewRepository {
  FakeReviewRepository()
    : super(auth: MockFirebaseAuth(), functions: FakeFunctionsService());

  @override
  Future<List<RoomReviewModel>> getRoomReviews(String roomId) async => const [];

  @override
  Future<ReviewSubmissionResult> submitReview({
    required String roomId,
    required int rating,
    required String comment,
    String? expectedReviewInstanceId,
  }) async => ReviewSubmissionResult(
    reviewId: 'REV-$roomId-test-student',
    reviewInstanceId: expectedReviewInstanceId ?? 'review-instance-test',
  );

  @override
  Future<void> deleteReview({
    required String roomId,
    required String reviewInstanceId,
  }) async {}

  @override
  Future<AdminReviewDeletionResult> deleteReviewAsAdmin({
    required String reviewId,
    required String reviewInstanceId,
  }) async => AdminReviewDeletionResult(
    reviewId: reviewId,
    reviewInstanceId: reviewInstanceId,
  );
}

/// The repository of the conversations.
class FakeConversationRepository extends ConversationRepository {
  FakeConversationRepository()
    : super(
        firestore: FakeFirestore(),
        auth: MockFirebaseAuth(),
        functions: FakeFunctionsService(),
      );

  @override
  Future<void> sendMessage({
    required String conversationId,
    required String receiverId,
    required String content,
    MessageType type = MessageType.text,
    String? roomId,
    String? imageUrl,
  }) async {}

  @override
  Future<void> markConversationRead(String conversationId) async {}

  @override
  Future<ConversationOpenResult> openConversation(
    String otherUserId, {
    String? roomId,
    String? requestId,
  }) async {
    return const ConversationOpenResult(
      conversationId: 'conversation-1',
      peerId: 'owner-1',
      peerName: 'Test Owner',
      roomId: 'room-1',
      roomTitle: 'Test Room',
      canSend: true,
    );
  }

  @override
  Future<ConversationInteractionDetails> getConversationInteractionDetails(
    String conversationId, {
    String? roomId,
    String? requestId,
  }) async {
    return const ConversationInteractionDetails(
      conversationId: 'conversation-1',
      peerId: 'owner-1',
      peerName: 'Test Owner',
      roomId: 'room-1',
      roomTitle: 'Test Room',
      canSend: true,
    );
  }

  @override
  Future<BookingInteractionDetails> getBookingInteractionDetails(
    String requestId,
  ) async {
    return const BookingInteractionDetails(
      requestId: 'request-1',
      studentId: 'student-1',
      ownerId: 'owner-1',
      studentName: 'Test Student',
      ownerName: 'Test Owner',
      roomId: 'room-1',
      roomTitle: 'Test Room',
      canSend: true,
    );
  }

  @override
  Future<RoomContactDetails> getRoomContactDetails(String roomId) async {
    return const RoomContactDetails(
      roomId: 'room-1',
      roomTitle: 'Test Room',
      ownerId: 'owner-1',
      ownerName: 'Test Owner',
    );
  }

  @override
  Future<UserBlockResult> blockUser(
    String otherUserId, {
    String? requestId,
    String? conversationId,
  }) async {
    return UserBlockResult(
      otherUserId: otherUserId,
      otherName: 'Test Owner',
      blockedByMe: true,
      canSend: false,
    );
  }

  @override
  Future<UserBlockResult> unblockUser(String otherUserId) async {
    return UserBlockResult(
      otherUserId: otherUserId,
      otherName: 'Test Owner',
      canSend: true,
    );
  }

  @override
  Future<String> getOtherParticipant(String conversationId) async => 'owner-1';
}

/// The repository of the notifications.
class FakeNotificationsRepository extends NotificationsRepository {
  FakeNotificationsRepository()
    : super(
        firestore: FakeFirestore(),
        auth: MockFirebaseAuth(),
        functions: FakeFunctionsService(),
      );

  @override
  Future<void> markAsRead(String notificationId) async {}

  @override
  Future<void> markAllAsRead() async {}

  @override
  Future<void> deleteNotification(String notificationId) async {}
}

/// The repository of the payments.
class FakePaymentRepository extends PaymentRepository {
  FakePaymentRepository()
    : super(
        firestore: FakeFirestore(),
        auth: MockFirebaseAuth(),
        functions: FakeFunctionsService(),
      );

  @override
  Future<UpiPaymentIntent> createPaymentIntent({
    required String requestId,
  }) async {
    return UpiPaymentIntent(
      uri: 'upi://pay?pa=stayserve',
      amount: 300,
      feePercentage: 30,
      payeeVpa: 'stayserve@upi',
      payeeName: 'StayServe',
      transactionRef: 'TXN-1',
    );
  }

  @override
  Future<void> submitPayment({
    required String requestId,
    required String reference,
    String method = 'upi',
  }) async {}

  @override
  Future<void> verifyPayment({
    required String requestId,
    required bool approve,
    String? note,
  }) async {}
}

/// The admin repository.
class FakeAdminRepository extends AdminRepository {
  FakeAdminRepository()
    : super(
        firestore: FakeFirestore(),
        functions: FakeFirebaseFunctions(),
        auth: MockFirebaseAuth(),
      );

  @override
  Future<void> toggleUserActive(String uid, bool isActive) async {}

  @override
  Future<void> updateUserRole(String uid, UserRole newRole) async {}

  @override
  Future<void> banUser(String uid, {String? reason}) async {}

  @override
  Future<void> unbanUser(String uid) async {}

  @override
  Future<void> deleteUser(String uid) async {}

  @override
  Future<AccountDeletionResult> deleteUserWithResult(String uid) async {
    return const AccountDeletionResult(
      completed: true,
      queued: false,
      blocked: false,
      retryable: false,
      state: 'completed',
      message: 'User deleted completely',
    );
  }

  @override
  Future<void> scheduleUserDeletion(String uid, {int days = 7}) async {}

  @override
  Future<void> cancelUserDeletion(String uid) async {}

  @override
  Future<void> updateRoomStatus(String roomId, RoomStatus status) async {}

  @override
  Future<void> deleteRoom(String roomId) async {}

  @override
  Future<void> adminReviewRequest(
    String requestId, {
    required bool approve,
    String? rejectionReason,
  }) async {}

  @override
  Future<void> markInvoicePaid(
    String invoiceId, {
    String? paymentReference,
    String? paymentMethod,
    String? upiTransactionId,
  }) async {}

  @override
  Future<void> cancelInvoice(String invoiceId) async {}

  @override
  Future<void> updateCommissionPercentage(double percentage) async {}

  @override
  Future<void> setMaintenanceMode(bool enabled) async {}

  @override
  Future<void> setNotificationsEnabled(bool enabled) async {}

  @override
  Future<void> setFeePayer(String payer) async {}

  @override
  Future<String> runMaintenanceTask(String task) async => 'done';

  @override
  Future<void> updateLaunchPincodeConfig({
    required List<String> enabledPincodes,
    required List<String> disabledPincodes,
    required String mode,
  }) async {}
}

// ---------------------------------------------------------------------------
// The data the screens show.
// ---------------------------------------------------------------------------

/// The auth repository — every action succeeds and does nothing.
/// A credential without the extra provider-specific data which none of the
/// audited screens reads.
class FakeUserCredential implements UserCredential {
  final User _user;

  FakeUserCredential(this._user);

  @override
  User get user => _user;

  @override
  AdditionalUserInfo? get additionalUserInfo => null;

  @override
  AuthCredential? get credential => null;
}

class FakeAuthRepository implements AuthRepository {
  @override
  Stream<User?> get authStateChanges => Stream.value(null);

  @override
  User? get currentUser => null;

  @override
  Future<User?> reloadCurrentUser() async => null;

  @override
  Future<List<FirebaseProviderIdentity>> linkedGoogleProviderIdentities({
    bool refresh = false,
  }) async => const <FirebaseProviderIdentity>[];

  @override
  Future<Map<String, dynamic>> rollbackIncompleteRegistration({
    required String uid,
  }) async => <String, dynamic>{
    'success': true,
    'rolledBack': false,
    'registrationCompleted': true,
  };

  @override
  Future<void> refreshIdToken() async {}

  @override
  Future<bool> refreshIdTokenAndCheckAccount() async => true;

  @override
  Future<void> signOut() async {}

  @override
  Future<void> sendPasswordResetEmail(String email) async {}

  @override
  Future<void> updateProfile({
    String? displayName,
    String? photoURL,
    bool removePhotoURL = false,
  }) async {}

  @override
  Future<UserModel?> getUserProfile(String uid) async => null;

  @override
  Future<void> updateUserProfile(String uid, Map<String, dynamic> data) async {}

  @override
  Future<void> createUserProfile(UserModel user) async {}

  @override
  Future<void> updateFCMToken(String uid, String token) async {}

  @override
  Future<void> deleteAccount() async {}

  @override
  Future<UserCredential> signUpWithEmailAndPassword({
    required String email,
    required String password,
  }) async => FakeUserCredential(MockUser(email: email));

  @override
  Future<UserCredential> signInWithEmailAndPassword({
    required String email,
    required String password,
  }) async => FakeUserCredential(MockUser(email: email));

  @override
  Future<UserCredential> signInWithGoogle() async =>
      FakeUserCredential(MockUser(email: 'google@example.test'));

  @override
  Future<UserCredential> linkGoogleProvider() async =>
      FakeUserCredential(MockUser(uid: 'linked-user'));

  @override
  Future<void> startPhoneVerification({
    required String phoneNumber,
    required void Function(PhoneAuthCredential credential)
    onVerificationCompleted,
    required void Function(FirebaseAuthException error) onVerificationFailed,
    required void Function(String verificationId, int? resendToken) onCodeSent,
    void Function(String verificationId)? onCodeAutoRetrievalTimeout,
    int? forceResendingToken,
  }) async {
    onCodeSent('audit-verification-id', 0);
  }

  @override
  PhoneAuthCredential phoneCredential({
    required String verificationId,
    required String smsCode,
  }) => PhoneAuthProvider.credential(
    verificationId: verificationId,
    smsCode: smsCode,
  );

  @override
  Future<UserCredential> signInWithPhoneCredential(
    PhoneAuthCredential credential,
  ) async => FakeUserCredential(
    MockUser(uid: 'phone-user', phoneNumber: '+919876543210'),
  );

  @override
  Future<UserCredential> linkPhoneCredential(
    PhoneAuthCredential credential,
  ) async => FakeUserCredential(
    MockUser(uid: 'linked-user', phoneNumber: '+919876543210'),
  );

  @override
  Future<Map<String, dynamic>> syncAuthProfile() async => <String, dynamic>{
    'success': true,
    'phoneVerified': true,
    'emailVerified': true,
  };

  @override
  Future<Map<String, dynamic>> linkVerifiedEmail({
    required String email,
    required String challenge,
  }) async => <String, dynamic>{
    'success': true,
    'email': email,
    'emailVerified': true,
  };

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

/// The OTP service — every call succeeds.
class FakeOtpService extends OtpService {
  FakeOtpService() : super(FakeFunctionsService());

  @override
  Future<OtpSendResult> sendOtp({
    required OtpChannel channel,
    required String identifier,
  }) async {
    return const OtpSendResult(
      success: true,
      delivered: true,
      expiresInSeconds: 300,
      resendAfterSeconds: 30,
    );
  }

  @override
  Future<OtpVerifyResult> verifyOtp({
    required OtpChannel channel,
    required String identifier,
    required String otp,
  }) async {
    return const OtpVerifyResult(
      verified: true,
      challenge: 'challenge-1',
      alreadyVerified: false,
    );
  }

  @override
  Future<void> registerUserRole({
    required String role,
    required String challenge,
  }) async {}

  @override
  Future<RegistrationResult> completeRegistration({
    required String name,
    required String role,
    required String challenge,
    String? phone,
    String? phoneChallenge,
    String? pincode,
  }) async => RegistrationResult(role: role, phoneVerified: false);
}

/// The location service — it always knows where the device is.
class FakeLocationService implements LocationService {
  @override
  Future<UserLocationResult> getUserLocation() async {
    return UserLocationResult(
      success: true,
      location: UserLocation(
        latitude: 12.9716,
        longitude: 77.5946,
        pincode: '560001',
        address: 'Test Address',
        city: 'Bengaluru',
        state: 'Karnataka',
        updatedAt: auditNow(),
      ),
      pincode: '560001',
    );
  }

  @override
  Future<UserLocation?> resolvePincodeLocation(String pincode) async {
    return UserLocation(
      latitude: 12.9716,
      longitude: 77.5946,
      pincode: pincode,
      updatedAt: auditNow(),
    );
  }

  @override
  Future<void> cacheLocation(UserLocation location) async {}

  @override
  Future<bool> openAppSettings() async => true;

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

DateTime auditNow() => DateTime(2026, 1, 1, 12);

/// An auth controller whose sign out does nothing.
class FakeAuthController extends AuthController {
  @override
  Future<void> build() async {}

  @override
  Future<void> signOut() async {}

  @override
  Future<void> signInWithGoogle() async {}

  @override
  Future<void> signInWithPhoneCredential(
    PhoneAuthCredential credential,
  ) async {}

  @override
  Future<void> linkPhoneCredential(
    PhoneAuthCredential credential, {
    String? phoneNumber,
  }) async {}

  @override
  Future<void> linkGoogleProvider() async {}

  @override
  Future<void> syncAuthProfile() async {}

  @override
  Future<void> linkVerifiedEmail({
    required String email,
    required String challenge,
  }) async {}
}

/// A location that is always the same.
class FakeUserLocationNotifier extends UserLocationNotifier {
  @override
  UserLocation? build() => UserLocation(
    latitude: 12.9716,
    longitude: 77.5946,
    pincode: '560001',
    address: 'Test Address',
    city: 'Bengaluru',
    state: 'Karnataka',
    updatedAt: auditNow(),
  );
}

/// The signed-in user of the audit.
MockUser auditMockUser({
  String uid = 'student-1',
  String email = 'student@example.test',
}) {
  return MockUser(uid: uid, email: email);
}

UserModel auditUser({
  String uid = 'student-1',
  String name = 'Test Student',
  String email = 'student@example.test',
  UserRole role = UserRole.student,
}) {
  return UserModel(
    uid: uid,
    name: name,
    email: email,
    phone: '9000000000',
    role: role,
    // The shared audit fixture represents a live account. Missing server
    // markers fail closed in the router and in the security rules, so the
    // fixture states them explicitly instead of relying on a permissive
    // model default.
    registrationCompleted: true,
    phoneVerified: true,
    createdAt: auditNow(),
    updatedAt: auditNow(),
    pincode: '560001',
  );
}

RoomModel auditRoom({
  String roomId = 'room-1',
  String ownerId = 'owner-1',
  String title = 'Test Room',
  double rent = 5000,
  RoomStatus status = RoomStatus.available,
  List<String> images = const [],
}) {
  return RoomModel(
    roomId: roomId,
    ownerId: ownerId,
    title: title,
    description: 'A comfortable room near the campus.',
    monthlyRent: rent,
    securityDeposit: rent * 2,
    location: const Location(city: 'Bengaluru', state: 'Karnataka'),
    roomType: RoomType.single,
    furnishing: FurnishingType.semi,
    availableFrom: auditNow(),
    amenities: const ['WiFi', 'AC'],
    occupancy: 2,
    currentOccupancy: 0,
    genderPreference: GenderPreference.any,
    images: images,
    status: status,
    createdAt: auditNow(),
    updatedAt: auditNow(),
    latitude: 12.9716,
    longitude: 77.5946,
  );
}

/// The owner-facing view of [auditRoom], including its exact private address.
OwnedRoomModel auditOwnedRoom({
  String roomId = 'room-1',
  String ownerId = 'owner-1',
  String title = 'Test Room',
  double rent = 5000,
  RoomStatus status = RoomStatus.available,
}) {
  return OwnedRoomModel(
    listing: auditRoom(
      roomId: roomId,
      ownerId: ownerId,
      title: title,
      rent: rent,
      status: status,
    ),
    privateLocation: RoomPrivateLocation(
      roomId: roomId,
      ownerId: ownerId,
      address: '42 Test Street',
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560001',
      latitude: 12.9716,
      longitude: 77.5946,
      updatedAt: auditNow(),
    ),
  );
}

JoinRequestModel auditRequest({
  String requestId = 'request-1',
  String roomId = 'room-1',
  String studentId = 'student-1',
  String ownerId = 'owner-1',
  JoinRequestStatus status = JoinRequestStatus.pending,
  bool advancePaid = false,
  PaymentStatus? paymentStatus,
}) {
  return JoinRequestModel(
    requestId: requestId,
    roomId: roomId,
    studentId: studentId,
    ownerId: ownerId,
    status: status,
    createdAt: auditNow(),
    updatedAt: auditNow(),
    monthlyRentAtJoin: 5000,
    commissionPercentageAtJoin: 30,
    advancePaid: advancePaid,
    advancePaymentStatus: paymentStatus,
  );
}

CommissionInvoiceModel auditInvoice({
  String invoiceId = 'INV-request-1',
  InvoiceStatus status = InvoiceStatus.pending,
}) {
  return CommissionInvoiceModel(
    invoiceId: invoiceId,
    roomId: 'room-1',
    ownerId: 'owner-1',
    tenantId: 'student-1',
    joinRequestId: 'request-1',
    monthlyRent: 5000,
    commissionPercentage: 30,
    commissionAmount: 1500,
    status: status,
    createdAt: auditNow(),
    updatedAt: auditNow(),
  );
}

PaymentModel auditPayment({
  String paymentId = 'payment-1',
  PaymentStatus status = PaymentStatus.submitted,
}) {
  return PaymentModel(
    paymentId: paymentId,
    requestId: 'request-1',
    studentId: 'student-1',
    ownerId: 'owner-1',
    roomId: 'room-1',
    amount: 1500,
    feePercentage: 30,
    reference: 'UPI-REF-1',
    method: 'upi',
    payeeVpa: 'stayserve@upi',
    status: status,
    submittedAt: auditNow(),
  );
}

RoomReviewModel auditReview() {
  return RoomReviewModel(
    reviewId: 'REV-room-1-student-1',
    reviewInstanceId: 'review-instance-1',
    roomId: 'room-1',
    studentId: 'student-1',
    ownerId: 'owner-1',
    joinRequestId: 'request-1',
    rating: 4,
    comment: 'Nice room.',
    studentName: 'Test Student',
    createdAt: auditNow(),
    updatedAt: auditNow(),
  );
}

ConversationModel auditConversation() {
  return ConversationModel(
    conversationId: 'conversation-1',
    participants: const ['student-1', 'owner-1'],
    lastMessage: 'Is the room still free?',
    lastMessageAt: auditNow(),
    unreadCount: const {'student-1': 1},
    roomId: 'room-1',
    createdAt: auditNow(),
    updatedAt: auditNow(),
  );
}

MessageModel auditMessage() {
  return MessageModel(
    messageId: 'message-1',
    conversationId: 'conversation-1',
    senderId: 'owner-1',
    receiverId: 'student-1',
    content: 'Yes, it is.',
    type: MessageType.text,
    createdAt: auditNow(),
  );
}
