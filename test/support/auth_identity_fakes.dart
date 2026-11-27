import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_auth_mocks/firebase_auth_mocks.dart';

import 'package:stayserve/firebase/auth/auth_service.dart';
import 'package:stayserve/firebase/functions/functions_service.dart';
import 'package:stayserve/models/user_model.dart';

/// A credential without provider-specific metadata.
class TestUserCredential implements UserCredential {
  TestUserCredential(this.user);

  @override
  final User user;

  @override
  AdditionalUserInfo? get additionalUserInfo => null;

  @override
  AuthCredential? get credential => null;
}

/// A linked-provider entry for [MockUser.providerData].
class TestProviderInfo extends UserInfo {
  TestProviderInfo(
    String providerId, {
    String uid = 'provider-user',
    String? email,
  }) : _providerId = providerId,
       super.fromJson({
         'uid': uid,
         'email': email,
         'displayName': null,
         'photoUrl': null,
         'phoneNumber': null,
         'isAnonymous': false,
         'isEmailVerified': true,
         'providerId': providerId,
         'tenantId': null,
         'refreshToken': null,
         'creationTimestamp': null,
         'lastSignInTimestamp': null,
       });

  final String _providerId;

  @override
  String get providerId => _providerId;
}

/// Firestore is deliberately unavailable in the identity unit tests.
class IdentityFakeFirestore implements FirebaseFirestore {
  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw StateError('Firestore is not available in this test');
}

/// Firebase Functions is deliberately unavailable in the identity unit tests.
class IdentityFakeFirebaseFunctions implements FirebaseFunctions {
  @override
  dynamic noSuchMethod(Invocation invocation) =>
      throw StateError('Firebase Functions is not available in this test');
}

/// A callable result with an in-memory payload.
class IdentityCallableResult implements HttpsCallableResult<dynamic> {
  IdentityCallableResult(this.data);

  @override
  final dynamic data;

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}

/// Records callable names and parameters without touching Firebase.
class RecordingFunctionsService extends FunctionsService {
  RecordingFunctionsService({
    this.payloads = const <String, dynamic>{},
    this.errors = const <String, Object>{},
  }) : super(IdentityFakeFirebaseFunctions());

  final Map<String, dynamic> payloads;
  final Map<String, Object> errors;
  final List<String> callNames = [];
  final List<Map<String, dynamic>> callParameters = [];

  @override
  Future<HttpsCallableResult<dynamic>> callFunction(
    String name, {
    Map<String, dynamic>? parameters,
  }) async {
    callNames.add(name);
    callParameters.add(
      Map<String, dynamic>.from(parameters ?? const <String, dynamic>{}),
    );
    final error = errors[name];
    if (error != null) throw error;
    return IdentityCallableResult(payloads[name] ?? <String, dynamic>{});
  }
}

/// A controllable auth repository for identity and routing tests.
class RecordingAuthRepository implements AuthRepository {
  RecordingAuthRepository({this.currentUser, this.profile});

  final List<String> calls = [];

  @override
  User? currentUser;

  /// The live profile returned by [getUserProfile].
  UserModel? profile;

  /// A phone number which the repository received from the UI.
  String? startedPhoneNumber;

  /// The arguments of the last credential which the UI created.
  String? credentialVerificationId;
  String? credentialSmsCode;

  /// Whether [startPhoneVerification] should report that the code was sent.
  bool sendCode = true;

  Object? linkPhoneError;
  Object? linkGoogleError;
  Object? linkVerifiedEmailError;
  Object? syncError;

  /// Optional asynchronous work for a profile synchronisation.
  Future<void> Function()? syncAuthProfileAction;

  /// The verification facts which the server reports after a sync.
  ///
  /// The server owns these facts: it re-reads the live Firebase Auth record
  /// together with the durable phone-verification proof. The fake therefore
  /// has to be able to answer "the phone is **not** verified" so that the
  /// client gate can be tested.
  bool syncPhoneVerified = true;
  bool syncEmailVerified = true;

  /// Whether the server answer omits the `phoneVerified` field entirely.
  ///
  /// A missing field is a failure too: the client must never infer a
  /// verification from an absent answer.
  bool syncOmitsPhoneVerified = false;

  /// Optional asynchronous work for a verified-email link.
  Future<void> Function()? linkVerifiedEmailAction;
  Object? updateProfileError;

  /// The Google-provider state which a failed native link leaves behind.
  ///
  /// Firebase can commit the provider link and then lose the response. The
  /// fake mirrors that state so the retry recovery can be tested without a
  /// real Google account chooser.
  Set<String>? googleProviderEmailsAfterFailedLink;

  /// The exact provider identities visible after a failed link attempt.
  ///
  /// This is optional; the email-only fixture remains supported for the
  /// existing tests.
  List<FirebaseProviderIdentity>? googleProviderIdentitiesAfterFailedLink;

  /// The phone number returned by a live Auth reload.
  String? livePhoneNumber;

  /// Uids passed to the server-side registration rollback.
  final List<String> rollbackUids = [];

  /// Direct client-side account deletions.
  int deleteAccountCalls = 0;

  /// The result returned by [rollbackIncompleteRegistration].
  Map<String, dynamic> rollbackResult = <String, dynamic>{
    'success': true,
    'rolledBack': true,
    'registrationCompleted': false,
  };

  /// The error returned by [rollbackIncompleteRegistration].
  Object? rollbackError;

  int googleProviderReloads = 0;
  int authReloads = 0;
  bool _googleLinkAttempted = false;

  @override
  Stream<User?> get authStateChanges => Stream<User?>.value(currentUser);

  @override
  Future<void> refreshIdToken() async {
    calls.add('refreshToken');
  }

  @override
  Future<bool> refreshIdTokenAndCheckAccount() async {
    calls.add('refreshToken');
    return true;
  }

  @override
  Future<void> signOut() async {
    calls.add('signOut');
    currentUser = null;
  }

  @override
  Future<UserModel?> getUserProfile(String uid) async => profile;

  @override
  Future<UserCredential> signUpWithEmailAndPassword({
    required String email,
    required String password,
  }) async {
    calls.add('signUpEmail');
    currentUser = MockUser(uid: 'signup-user', email: email);
    return TestUserCredential(currentUser!);
  }

  @override
  Future<void> updateProfile({
    String? displayName,
    String? photoURL,
    bool removePhotoURL = false,
  }) async {
    calls.add('updateAuthProfile');
    final error = updateProfileError;
    if (error != null) throw error;
  }

  @override
  Future<UserCredential> signInWithPhoneCredential(
    PhoneAuthCredential credential,
  ) async {
    calls.add('signInWithPhone');
    return TestUserCredential(
      MockUser(
        uid: currentUser?.uid ?? 'phone-user',
        phoneNumber: currentUser?.phoneNumber ?? '+919876543210',
      ),
    );
  }

  @override
  Future<UserCredential> linkPhoneCredential(
    PhoneAuthCredential credential,
  ) async {
    calls.add('linkPhone');
    final error = linkPhoneError;
    if (error != null) throw error;
    return TestUserCredential(
      MockUser(
        uid: currentUser?.uid ?? 'linked-user',
        phoneNumber: currentUser?.phoneNumber ?? '+919876543210',
      ),
    );
  }

  @override
  Future<UserCredential> linkGoogleProvider() async {
    calls.add('linkGoogle');
    _googleLinkAttempted = true;
    final error = linkGoogleError;
    if (error != null) throw error;
    return TestUserCredential(
      MockUser(
        uid: currentUser?.uid ?? 'linked-user',
        providerData: [TestProviderInfo('google.com')],
      ),
    );
  }

  @override
  Future<List<FirebaseProviderIdentity>> linkedGoogleProviderIdentities({
    bool refresh = false,
  }) async {
    if (refresh) {
      googleProviderReloads++;
      authReloads++;
    }

    final committedIdentities = googleProviderIdentitiesAfterFailedLink;
    if (_googleLinkAttempted && committedIdentities != null) {
      return List<FirebaseProviderIdentity>.from(committedIdentities);
    }

    final committedEmails = googleProviderEmailsAfterFailedLink;
    if (_googleLinkAttempted && committedEmails != null) {
      return committedEmails
          .map(
            (email) => FirebaseProviderIdentity(
              providerId: 'google.com',
              uid: 'recovered-$email',
              email: email,
            ),
          )
          .toList(growable: false);
    }

    final identities = <FirebaseProviderIdentity>[];
    for (final provider in currentUser?.providerData ?? const <UserInfo>[]) {
      if (provider.providerId != 'google.com') continue;
      final providerUid = provider.uid;
      if (providerUid == null || providerUid.isEmpty) continue;
      identities.add(
        FirebaseProviderIdentity(
          providerId: provider.providerId,
          uid: providerUid,
          email: provider.email,
        ),
      );
    }
    return List<FirebaseProviderIdentity>.unmodifiable(identities);
  }

  @override
  Future<Set<String>> linkedGoogleProviderEmails({bool refresh = false}) async {
    final identities = await linkedGoogleProviderIdentities(refresh: refresh);
    return identities
        .map((identity) => identity.normalizedEmail)
        .where((email) => email.isNotEmpty)
        .toSet();
  }

  @override
  Future<User?> reloadCurrentUser() async {
    authReloads++;
    final user = currentUser;
    if (user == null) return null;
    currentUser = MockUser(
      uid: user.uid,
      email: user.email,
      phoneNumber: livePhoneNumber ?? user.phoneNumber,
      providerData: user.providerData,
    );
    return currentUser;
  }

  @override
  Future<void> deleteAccount() async {
    deleteAccountCalls++;
    calls.add('deleteAccount');
    currentUser = null;
  }

  @override
  Future<Map<String, dynamic>> rollbackIncompleteRegistration({
    required String uid,
  }) async {
    calls.add('rollbackIncompleteRegistration');
    rollbackUids.add(uid);
    final error = rollbackError;
    if (error != null) throw error;
    if (rollbackResult['rolledBack'] == true) currentUser = null;
    return Map<String, dynamic>.from(rollbackResult);
  }

  @override
  Future<Map<String, dynamic>> syncAuthProfile() async {
    calls.add('syncAuthProfile');
    final error = syncError;
    if (error != null) throw error;
    final action = syncAuthProfileAction;
    if (action != null) await action();
    return <String, dynamic>{
      'success': true,
      if (!syncOmitsPhoneVerified) 'phoneVerified': syncPhoneVerified,
      'emailVerified': syncEmailVerified,
    };
  }

  @override
  Future<Map<String, dynamic>> linkVerifiedEmail({
    required String email,
    required String challenge,
  }) async {
    calls.add('linkVerifiedEmail');
    final error = linkVerifiedEmailError;
    if (error != null) throw error;
    final action = linkVerifiedEmailAction;
    if (action != null) await action();
    return <String, dynamic>{
      'success': true,
      'email': email,
      'emailVerified': true,
    };
  }

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
    calls.add('startPhoneVerification');
    startedPhoneNumber = phoneNumber;
    if (sendCode) onCodeSent('verification-id', 0);
  }

  @override
  PhoneAuthCredential phoneCredential({
    required String verificationId,
    required String smsCode,
  }) {
    calls.add('createPhoneCredential');
    credentialVerificationId = verificationId;
    credentialSmsCode = smsCode;
    return PhoneAuthProvider.credential(
      verificationId: verificationId,
      smsCode: smsCode,
    );
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => null;
}
