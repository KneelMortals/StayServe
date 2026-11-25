import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:cloud_firestore/cloud_firestore.dart';

import '../../core/utils/app_logger.dart';
import '../../models/user_model.dart';
import '../functions/functions_service.dart';

/// Makes sure that Firebase keeps the signed-in user across app restarts.
///
/// Native FlutterFire apps persist Auth state on the device by default and
/// do not expose a persistence switch there. The web implementation does
/// expose it, so the web build explicitly requests local persistence before
/// the first frame is rendered.
///
/// [isWeb] is injectable for tests; production always uses the current
/// platform.
Future<void> configureAuthPersistence(
  FirebaseAuth auth, {
  bool isWeb = kIsWeb,
}) async {
  if (!isWeb) return;
  await auth.setPersistence(Persistence.LOCAL);
}

final firebaseAuthProvider = Provider<FirebaseAuth>(
  (ref) => FirebaseAuth.instance,
);
final firestoreProvider = Provider<FirebaseFirestore>(
  (ref) => FirebaseFirestore.instance,
);

/// The identity of one provider linked to a Firebase Auth account.
///
/// Provider ids and provider uids are the authoritative identity of a linked
/// provider. An email address is useful for diagnostics, but it is not a
/// unique identity: two Google accounts can, in theory, expose the same
/// address. Recovery code therefore compares the complete provider identity
/// whenever Firebase gives us one.
class FirebaseProviderIdentity {
  const FirebaseProviderIdentity({
    required this.providerId,
    required this.uid,
    this.email,
  });

  final String providerId;
  final String uid;
  final String? email;

  String get normalizedEmail => email?.trim().toLowerCase() ?? '';

  /// A stable key for comparing provider records before and after a link.
  String get key => '$providerId\u0000$uid\u0000$normalizedEmail';

  @override
  bool operator ==(Object other) {
    return other is FirebaseProviderIdentity &&
        other.providerId == providerId &&
        other.uid == uid &&
        other.normalizedEmail == normalizedEmail;
  }

  @override
  int get hashCode => Object.hash(providerId, uid, normalizedEmail);
}

final authRepositoryProvider = Provider<AuthRepository>((ref) {
  return AuthRepository(
    ref.watch(firebaseAuthProvider),
    ref.watch(firestoreProvider),
    ref.watch(functionsServiceProvider),
  );
});

class AuthRepository {
  final FirebaseAuth _auth;
  final FirebaseFirestore _firestore;
  final FunctionsService _functions;

  AuthRepository(this._auth, this._firestore, this._functions);

  Stream<User?> get authStateChanges => _auth.authStateChanges();

  User? get currentUser => _auth.currentUser;

  /// Forces a refresh of the ID token.
  ///
  /// The custom claims (`role`, `admin`) are attached by the Cloud Functions
  /// *after* the account was created, so the token that was issued at
  /// sign-up time does not contain them yet. The same applies when an admin
  /// grants somebody the admin role — that user's token stays stale until it
  /// is refreshed, and the server would keep rejecting their admin calls.
  Future<void> refreshIdToken() async {
    final user = _auth.currentUser;
    if (user == null) return;
    try {
      await user.getIdToken(true);
    } catch (e) {
      // A failed refresh must never break the session.
      AppLogger.warning('Could not refresh the ID token', error: e);
    }
  }

  Future<UserCredential> signUpWithEmailAndPassword({
    required String email,
    required String password,
  }) async {
    return await _auth.createUserWithEmailAndPassword(
      email: email.trim(),
      password: password,
    );
  }

  Future<UserCredential> signInWithEmailAndPassword({
    required String email,
    required String password,
  }) async {
    return await _auth.signInWithEmailAndPassword(
      email: email.trim(),
      password: password,
    );
  }

  /// Signs in with Google's OpenID Connect provider through Firebase Auth.
  ///
  /// Native platforms use Firebase Auth's provider flow. The web build uses
  /// the popup flow because the native provider entry point does not exist
  /// in a browser.
  Future<UserCredential> signInWithGoogle() async {
    final provider = GoogleAuthProvider();
    if (kIsWeb) {
      return await _auth.signInWithPopup(provider);
    }
    return await _auth.signInWithProvider(provider);
  }

  /// Links the signed-in account to a Google OpenID Connect identity.
  Future<UserCredential> linkGoogleProvider() async {
    final user = _auth.currentUser;
    if (user == null) {
      throw StateError('You have to be signed in before linking Google.');
    }
    final provider = GoogleAuthProvider();
    if (kIsWeb) {
      return await user.linkWithPopup(provider);
    }
    return await user.linkWithProvider(provider);
  }

  /// Reloads the current Firebase Auth user and returns the live instance.
  ///
  /// The object returned by [FirebaseAuth.currentUser] can still contain the
  /// provider and phone state from before a link operation. A link recovery
  /// must therefore reload the user before it compares that state.
  Future<User?> reloadCurrentUser() async {
    final user = _auth.currentUser;
    if (user == null) return null;
    await user.reload();

    // `User.reload()` refreshes the platform delegate. On native Firebase it
    // replaces `FirebaseAuth.currentUser` with a new `User` instance, while
    // the object which was asked to reload can still expose its old provider
    // and phone state. Always return the instance which Firebase Auth now
    // considers current.
    return _auth.currentUser;
  }

  /// The live identities of the Google providers linked to this account.
  ///
  /// [refresh] reloads the current Auth user first. This is required before
  /// and after a link attempt: Firebase can commit the provider and lose the
  /// response, while the local [User] object remains stale.
  Future<List<FirebaseProviderIdentity>> linkedGoogleProviderIdentities({
    bool refresh = false,
  }) async {
    var user = _auth.currentUser;
    if (user == null) return const <FirebaseProviderIdentity>[];
    if (refresh) {
      await user.reload();

      // Native Firebase replaces the current `User` instance during reload.
      // Reading provider data from the pre-reload object would therefore
      // compare stale identities and could approve the wrong Google link.
      user = _auth.currentUser ?? user;
    }
    final identities = <FirebaseProviderIdentity>[];
    for (final provider in user.providerData) {
      if (provider.providerId != 'google.com') continue;
      final providerUid = provider.uid;
      // Firebase's public UserInfo API types a provider uid as nullable.
      // A Google provider without one cannot be compared safely, so it is
      // omitted and recovery fails closed instead of treating it as an
      // identifiable provider.
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

  /// The email addresses of the Google providers linked to this account.
  ///
  /// This compatibility helper is intentionally based on the live provider
  /// identities. New code should use [linkedGoogleProviderIdentities] so it
  /// can compare the provider itself rather than only its email address.
  Future<Set<String>> linkedGoogleProviderEmails({bool refresh = false}) async {
    final identities = await linkedGoogleProviderIdentities(refresh: refresh);
    return identities
        .map((identity) => identity.normalizedEmail)
        .where((email) => email.isNotEmpty)
        .toSet();
  }

  /// Starts Firebase's phone-number verification.
  ///
  /// Firebase sends the SMS itself. This is independent from StayServe's
  /// legacy email/mobile OTP callable and does not use the Twilio,
  /// Fast2SMS or MSG91 environment variables.
  Future<void> startPhoneVerification({
    required String phoneNumber,
    required void Function(PhoneAuthCredential credential)
    onVerificationCompleted,
    required void Function(FirebaseAuthException error) onVerificationFailed,
    required void Function(String verificationId, int? resendToken) onCodeSent,
    void Function(String verificationId)? onCodeAutoRetrievalTimeout,
    int? forceResendingToken,
  }) async {
    await _auth.verifyPhoneNumber(
      phoneNumber: phoneNumber,
      forceResendingToken: forceResendingToken,
      verificationCompleted: onVerificationCompleted,
      verificationFailed: onVerificationFailed,
      codeSent: onCodeSent,
      codeAutoRetrievalTimeout:
          onCodeAutoRetrievalTimeout ?? (verificationId) {},
      timeout: const Duration(seconds: 60),
    );
  }

  /// Creates a Firebase credential from the SMS code entered by the user.
  PhoneAuthCredential phoneCredential({
    required String verificationId,
    required String smsCode,
  }) {
    return PhoneAuthProvider.credential(
      verificationId: verificationId,
      smsCode: smsCode.trim(),
    );
  }

  /// Signs a new user in with a verified Firebase phone number.
  Future<UserCredential> signInWithPhoneCredential(
    PhoneAuthCredential credential,
  ) async {
    return await _auth.signInWithCredential(credential);
  }

  /// Links a verified Firebase phone number to the signed-in account.
  Future<UserCredential> linkPhoneCredential(
    PhoneAuthCredential credential,
  ) async {
    final user = _auth.currentUser;
    if (user == null) {
      throw StateError(
        'You have to be signed in before verifying a phone number.',
      );
    }
    return await user.linkWithCredential(credential);
  }

  /// Copies the live Firebase identity facts into the server-owned profile.
  ///
  /// The token is refreshed first so the callable is authenticated with the
  /// latest session claims. The server then re-reads the live Firebase Auth
  /// record; it is the only writer of `phone`, `phoneVerified`,
  /// `emailVerified` and `authProviders`.
  Future<Map<String, dynamic>> syncAuthProfile() async {
    final user = _auth.currentUser;
    if (user == null) {
      throw StateError(
        'You have to be signed in before updating verification details.',
      );
    }
    await user.getIdToken(true);
    final result = await _functions.callFunction('syncAuthProfile');
    return Map<String, dynamic>.from(result.data as Map);
  }

  /// Asks the server to roll back the registration of this account.
  ///
  /// The server compares the live profile with a durable rollback marker in
  /// the same transaction which completes a registration. It therefore never
  /// deletes an account whose registration committed while the client was
  /// reconciling a lost response.
  Future<Map<String, dynamic>> rollbackIncompleteRegistration({
    required String uid,
  }) async {
    final result = await _functions.callFunction(
      'rollbackIncompleteRegistration',
      parameters: {'uid': uid},
    );
    return Map<String, dynamic>.from(result.data as Map);
  }

  /// Adds a verified email address to a phone-first account.
  ///
  /// The one-time challenge comes from StayServe's email OTP flow. The
  /// server validates it and updates Firebase Auth itself, so the client
  /// cannot mark an arbitrary address as verified.
  Future<Map<String, dynamic>> linkVerifiedEmail({
    required String email,
    required String challenge,
  }) async {
    final result = await _functions.callFunction(
      'linkVerifiedEmail',
      parameters: {'email': email.trim(), 'challenge': challenge.trim()},
    );
    return Map<String, dynamic>.from(result.data as Map);
  }

  Future<void> signOut() async {
    await _auth.signOut();
  }

  Future<void> sendPasswordResetEmail(String email) async {
    await _auth.sendPasswordResetEmail(email: email.trim());
  }

  Future<void> updateProfile({String? displayName, String? photoURL}) async {
    final user = _auth.currentUser;
    if (user != null) {
      // `updateProfile` on Firebase Auth accepts nullable values. Passing a
      // null display name therefore clears the name even when the caller only
      // wanted to remove a photo. Only fields explicitly supplied by the
      // caller may be changed.
      if (displayName != null) {
        await user.updateDisplayName(displayName);
      }
      if (photoURL != null) {
        await user.updatePhotoURL(photoURL);
      }
    }
  }

  /// Writes the **self-service** part of an existing Firestore profile.
  ///
  /// Profiles are created by the server's Auth trigger and completed by the
  /// registration callable. This legacy method remains for callers which
  /// already have a server-created profile, but it deliberately uses
  /// `update` so it can never create a partial client profile.
  @Deprecated(
    'Profiles are server-owned; use updateUserProfile for an existing profile',
  )
  Future<void> createUserProfile(UserModel user) async {
    await _firestore.collection('users').doc(user.uid).update({
      'uid': user.uid,
      'name': user.name,
      // `phone`, `email`, their verification flags and the provider list
      // are server-owned. They are copied from signed Firebase Auth claims
      // and must never be written by this client method.
      'profileImage': user.profileImage,
      'pincode': user.pincode,
      'updatedAt': FieldValue.serverTimestamp(),
    });
  }

  Future<UserModel?> getUserProfile(String uid) async {
    final doc = await _firestore.collection('users').doc(uid).get();
    if (!doc.exists) return null;
    try {
      return UserModel.fromJson(doc.data()!);
    } catch (e) {
      // A profile that cannot be parsed must not throw: the caller uses this
      // during sign-in, and an exception here would be reported to the user
      // as an authentication failure even though the sign-in itself worked.
      AppLogger.warning('The profile of $uid could not be read', error: e);
      return null;
    }
  }

  Future<void> updateUserProfile(String uid, Map<String, dynamic> data) async {
    await _firestore.collection('users').doc(uid).update({
      ...data,
      'updatedAt': FieldValue.serverTimestamp(),
    });
  }

  Future<void> updateFCMToken(String uid, String token) async {
    await _firestore.collection('users').doc(uid).update({
      'fcmToken': token,
      'updatedAt': FieldValue.serverTimestamp(),
    });
  }

  /// Deletes the account of the signed-in user.
  ///
  /// The Firestore profile is **not** deleted by the client: the rules deny
  /// a client delete, because a profile-less Auth session would survive.
  /// Deleting the Auth account triggers the `onUserDelete` function, which
  /// removes the profile, the rooms, the requests, the payments and the
  /// messages on the server.
  Future<void> deleteAccount() async {
    final user = _auth.currentUser;
    if (user != null) {
      await user.delete();
    }
  }
}
