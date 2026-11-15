import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:cloud_firestore/cloud_firestore.dart';

import '../../core/utils/app_logger.dart';
import '../../models/user_model.dart';

final firebaseAuthProvider = Provider<FirebaseAuth>(
  (ref) => FirebaseAuth.instance,
);
final firestoreProvider = Provider<FirebaseFirestore>(
  (ref) => FirebaseFirestore.instance,
);

final authRepositoryProvider = Provider<AuthRepository>((ref) {
  return AuthRepository(
    auth: ref.watch(firebaseAuthProvider),
    firestore: ref.watch(firestoreProvider),
  );
});

class AuthRepository {
  final FirebaseAuth _auth;
  final FirebaseFirestore _firestore;

  AuthRepository({required this._auth, required this._firestore});

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

  Future<void> signOut() async {
    await _auth.signOut();
  }

  Future<void> sendPasswordResetEmail(String email) async {
    await _auth.sendPasswordResetEmail(email: email.trim());
  }

  Future<void> updateProfile({String? displayName, String? photoURL}) async {
    final user = _auth.currentUser;
    if (user != null) {
      await user.updateDisplayName(displayName);
      if (photoURL != null) {
        await user.updatePhotoURL(photoURL);
      }
    }
  }

  /// Writes the **self-service** part of the Firestore profile of [user].
  ///
  /// The role, the active flag and the registration marker are server-owned
  /// (the `onUserCreate` trigger and `completeRegistration` write them), and
  /// the Firestore rules reject a client that tries to change them. Only the
  /// fields a user may change on their own profile are sent here.
  Future<void> createUserProfile(UserModel user) async {
    await _firestore.collection('users').doc(user.uid).set({
      'uid': user.uid,
      'name': user.name,
      'phone': user.phone,
      'profileImage': user.profileImage,
      'pincode': user.pincode,
      'updatedAt': FieldValue.serverTimestamp(),
    }, SetOptions(merge: true));
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
