import 'dart:async';
import 'dart:convert';

import 'package:firebase_auth/firebase_auth.dart';

import '../../core/utils/app_logger.dart';

/// The number of times a refused listener is attached again.
const int _kMaxRecoveryAttempts = 5;

/// The delay before the first new attempt. It grows with every attempt.
const Duration _kRecoveryDelay = Duration(milliseconds: 400);

/// Restarts a Firestore listener which the security rules refused.
///
/// A listener can be attached while Firebase Auth is still switching the
/// account. The Firestore client then evaluates the read with the token of
/// the **previous** account, the rules refuse it, and the listener stops for
/// good — the screen shows "Could not load …" although the new account is
/// allowed to read the data.
///
/// The listener is therefore attached again after a short delay. The delay
/// grows with every attempt, so a real permission problem is not hammered:
/// after the last attempt the error is handed to the caller, which shows it
/// together with a way to try again.
Stream<T> firestoreListenerWithRecovery<T>(
  Stream<T> source, {
  required String description,
  FirebaseAuth? auth,
  int maxAttempts = _kMaxRecoveryAttempts,
  Duration delay = _kRecoveryDelay,
}) {
  var attempt = 0;
  StreamSubscription<T>? subscription;
  Timer? timer;
  var closed = false;

  late final StreamController<T> controller;
  controller = StreamController<T>(
    onListen: () {
      void attach() {
        if (closed) return;
        subscription = source.listen(
          (value) {
            if (!closed) controller.add(value);
          },
          onError: (Object error, StackTrace stackTrace) {
            if (closed) return;
            if (attempt >= maxAttempts) {
              controller.addError(error, stackTrace);
              return;
            }
            attempt++;
            final wait = delay * attempt;
            AppLogger.warning(
              'The listener "$description" was refused; it is attached again '
              'in ${wait.inMilliseconds} ms',
              error: error,
            );
            logFirestoreIdentity(auth, description);
            unawaited(subscription?.cancel());
            timer = Timer(wait, attach);
          },
          onDone: () {
            if (!closed) unawaited(controller.close());
          },
        );
      }

      attach();
    },
    onCancel: () async {
      closed = true;
      timer?.cancel();
      await subscription?.cancel();
    },
  );

  return controller.stream;
}

/// Logs the identity which a Firestore request is made with.
///
/// The claims of the token explain most of the refusals: a token without the
/// signed proof of the verified phone number is refused by the rules which
/// require that proof, and a token of another account is refused by every
/// owner-scoped rule.
void logFirestoreIdentity(FirebaseAuth? auth, String description) {
  final user = auth?.currentUser;
  if (user == null) {
    AppLogger.warning(
      'The refused listener "$description" ran without a signed-in account',
    );
    return;
  }

  unawaited(
    user
        .getIdToken()
        .then((token) {
          if (token == null) {
            AppLogger.warning(
              'The refused listener "$description" has no identity token',
            );
            return;
          }
          final claims = _claimsOf(token);
          AppLogger.warning(
            'The refused listener "$description" ran as ${user.uid} '
            '(phone: ${claims['phone_number'] ?? '-'}, '
            'verified phone claim: ${claims['stayServeVerifiedPhone'] ?? '-'}, '
            'role: ${claims['role'] ?? '-'})',
          );
        })
        .catchError((Object error) {
          AppLogger.warning(
            'Could not read the identity token of ${user.uid}',
            error: error,
          );
        }),
  );
}

/// The claims of an identity token.
Map<String, dynamic> _claimsOf(String token) {
  try {
    final parts = token.split('.');
    if (parts.length < 2) return const <String, dynamic>{};
    final payload = jsonDecode(
      utf8.decode(base64Url.decode(base64Url.normalize(parts[1]))),
    );
    if (payload is! Map<String, dynamic>) return const <String, dynamic>{};
    return payload;
  } catch (_) {
    return const <String, dynamic>{};
  }
}
