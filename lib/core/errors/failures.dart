import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_auth/firebase_auth.dart';

abstract class Failure {
  final String message;
  final String? code;
  const Failure(this.message, [this.code]);

  @override
  String toString() =>
      'Failure: $message${code != null ? ' (Code: $code)' : ''}';
}

class ServerFailure extends Failure {
  const ServerFailure(super.message, [super.code]);
}

class CacheFailure extends Failure {
  const CacheFailure(super.message, [super.code]);
}

class NetworkFailure extends Failure {
  const NetworkFailure(super.message, [super.code]);
}

class AuthFailure extends Failure {
  const AuthFailure(super.message, [super.code]);

  factory AuthFailure.fromFirebaseAuthException(FirebaseAuthException e) {
    switch (e.code) {
      case 'email-already-in-use':
        return const AuthFailure(
          'This email is already registered. Please login.',
          'EMAIL_EXISTS',
        );
      case 'invalid-email':
        return const AuthFailure(
          'Please enter a valid email address.',
          'INVALID_EMAIL',
        );
      case 'weak-password':
        return const AuthFailure(
          'Password should be at least 6 characters.',
          'WEAK_PASSWORD',
        );
      case 'user-not-found':
        return const AuthFailure(
          'No account found with this email.',
          'USER_NOT_FOUND',
        );
      case 'wrong-password':
        return const AuthFailure(
          'Incorrect password. Please try again.',
          'WRONG_PASSWORD',
        );
      // Firebase Auth 5.x reports a wrong e-mail *or* a wrong password with
      // this one code, so it needs its own message — without it the user
      // was told that "no account was found" even when the account was
      // there and only the password was wrong.
      case 'invalid-credential':
        return const AuthFailure(
          'Incorrect email or password. Please try again.',
          'INVALID_CREDENTIAL',
        );
      case 'invalid-login-credentials':
        return const AuthFailure(
          'Incorrect email or password. Please try again.',
          'INVALID_CREDENTIAL',
        );
      case 'too-many-requests':
        return const AuthFailure(
          'Too many attempts. Please try again later.',
          'TOO_MANY_REQUESTS',
        );
      case 'user-disabled':
        return const AuthFailure(
          'This account has been disabled.',
          'USER_DISABLED',
        );
      case 'operation-not-allowed':
        return const AuthFailure(
          'This sign-in method is not enabled.',
          'OPERATION_NOT_ALLOWED',
        );
      case 'network-request-failed':
        return const AuthFailure(
          'Network error. Please check your connection.',
          'NETWORK_ERROR',
        );
      default:
        return AuthFailure(
          e.message ?? 'Authentication failed. Please try again.',
          e.code,
        );
    }
  }
}

/// An error raised by one named operation while another operation may be
/// running at the same time.
///
/// The cause is kept intact for diagnostics, while [readableAuthError] can
/// still turn it into the same user-facing message as the original error.
class OperationException implements Exception {
  const OperationException({
    required this.operation,
    required this.cause,
    this.causeStackTrace,
  });

  final String operation;
  final Object cause;
  final StackTrace? causeStackTrace;

  @override
  String toString() => cause.toString();
}

/// Turns any error into a message that can be shown to the user.
///
/// The screens used to display `error.toString()`, which dumped raw
/// framework internals such as
/// `FirebaseAuthException [firebase_auth/invalid-credential] …` or
/// `Exception: type 'Null' is not a subtype of type 'String'` into a
/// snack bar. That is what users reported as an "auth issue": the sign-in
/// itself worked, but the app showed an unreadable technical message.
String readableAuthError(Object error) {
  if (error is OperationException) {
    return readableAuthError(error.cause);
  }
  if (error is AuthFailure) return error.message;
  if (error is Failure) return error.message;
  if (error is FirebaseAuthException) {
    return AuthFailure.fromFirebaseAuthException(error).message;
  }
  if (error is FirebaseFunctionsException) {
    final message = error.message;
    if (message == null || message.trim().isEmpty) {
      return 'The server could not complete the request. Please try again.';
    }
    return message;
  }
  if (error is FirebaseException) {
    return FirestoreFailure.fromFirebaseException(error).message;
  }
  if (error is Exception) {
    final text = error.toString();
    // Strip the noisy prefixes Dart adds so the user sees the real reason.
    return text
        .replaceFirst(
          RegExp(r'^(Exception|Bad state|PlatformException)\s*:\s*'),
          '',
        )
        .replaceFirst(RegExp(r'^\[[^\]]+\]\s*'), '')
        .trim();
  }
  return error.toString();
}

class FirestoreFailure extends Failure {
  const FirestoreFailure(super.message, [super.code]);

  factory FirestoreFailure.fromFirebaseException(FirebaseException e) {
    switch (e.code) {
      case 'permission-denied':
        return const FirestoreFailure(
          'You do not have permission to perform this action.',
          'PERMISSION_DENIED',
        );
      case 'not-found':
        return const FirestoreFailure(
          'The requested resource was not found.',
          'NOT_FOUND',
        );
      case 'already-exists':
        return const FirestoreFailure(
          'This resource already exists.',
          'ALREADY_EXISTS',
        );
      case 'resource-exhausted':
        return const FirestoreFailure(
          'Too many requests. Please try again later.',
          'RESOURCE_EXHAUSTED',
        );
      case 'unavailable':
        return const FirestoreFailure(
          'Service temporarily unavailable. Please try again.',
          'UNAVAILABLE',
        );
      default:
        return FirestoreFailure(
          e.message ?? 'Database operation failed.',
          e.code,
        );
    }
  }
}

class ValidationFailure extends Failure {
  final Map<String, String> fieldErrors;
  const ValidationFailure(super.message, this.fieldErrors, [super.code]);

  factory ValidationFailure.single(String field, String message) {
    return ValidationFailure('Validation failed', {
      field: message,
    }, 'VALIDATION_ERROR');
  }
}

class StorageFailure extends Failure {
  const StorageFailure(super.message, [super.code]);
}

class PaymentFailure extends Failure {
  const PaymentFailure(super.message, [super.code]);
}

class PermissionFailure extends Failure {
  const PermissionFailure(super.message, [super.code]);
}
