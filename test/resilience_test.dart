import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stayserve/core/constants/enums.dart';
import 'package:stayserve/core/errors/failures.dart';
import 'package:stayserve/models/launch_pincode_config.dart';
import 'package:stayserve/models/user_model.dart';

void main() {
  group('UserModel.fromJson', () {
    test('reads a complete profile', () {
      final user = UserModel.fromJson({
        'uid': 'uid-1',
        'name': 'Asha',
        'email': 'asha@example.com',
        'phone': '9876543210',
        'role': 'owner',
        'profileImage': 'https://example.com/a.png',
        'fcmToken': 'token',
        'isActive': false,
        'createdAt': Timestamp.fromDate(DateTime.utc(2026, 1, 2)),
        'updatedAt': Timestamp.fromDate(DateTime.utc(2026, 1, 3)),
        'savedRooms': ['room-1', 'room-2'],
        'pincode': '560001',
      });

      expect(user.uid, 'uid-1');
      expect(user.name, 'Asha');
      expect(user.email, 'asha@example.com');
      expect(user.phone, '9876543210');
      expect(user.role, UserRole.owner);
      expect(user.isActive, isFalse);
      expect(user.savedRooms, ['room-1', 'room-2']);
      expect(user.pincode, '560001');
      // A Firestore timestamp is always read back in the local time zone, so
      // the instant is compared in UTC.
      expect(user.createdAt.toUtc(), DateTime.utc(2026, 1, 2));
    });

    // A profile document is not schema-enforced: it may have been written by
    // an older version of the app or straight from the Firebase console. The
    // hard `as String` casts that used to be here threw a TypeError, which
    // killed the session stream and sent the user back to the login screen
    // with an "auth" error even though Firebase Authentication had worked.
    test('survives a completely empty document', () {
      final user = UserModel.fromJson({});
      expect(user.uid, '');
      expect(user.name, '');
      expect(user.email, '');
      expect(user.phone, isNull);
      expect(user.role, UserRole.student);
      expect(user.isActive, isTrue);
      expect(user.savedRooms, isEmpty);
      expect(user.bankDetails, isNull);
    });

    test('survives fields that hold the wrong type', () {
      final user = UserModel.fromJson({
        'uid': 12345,
        'name': true,
        'email': 42,
        'phone': 9876543210,
        'profileImage': 3.5,
        'fcmToken': false,
        'pincode': 560001,
        'isActive': 'yes',
        'role': 'wizard',
        'savedRooms': ['room-1', 7, null],
        'createdAt': '2026-01-02T00:00:00.000Z',
        'updatedAt': 'not-a-date',
      });

      expect(user.uid, '12345');
      expect(user.name, 'true');
      expect(user.email, '42');
      expect(user.phone, '9876543210');
      expect(user.profileImage, '3.5');
      expect(user.fcmToken, 'false');
      expect(user.pincode, '560001');
      // An unknown role falls back to `student` instead of throwing.
      expect(user.role, UserRole.student);
      // Only the real strings survive in the saved rooms.
      expect(user.savedRooms, ['room-1']);
      // An ISO date string is understood ...
      expect(user.createdAt, DateTime.utc(2026, 1, 2));
      // ... and a broken one falls back to the epoch instead of throwing.
      expect(user.updatedAt, DateTime.fromMillisecondsSinceEpoch(0));
    });

    test('survives a malformed bank block', () {
      final withoutUpi = UserModel.fromJson({
        'uid': 'uid-1',
        'bankDetails': {'accountHolderName': 'Asha'},
      });
      expect(withoutUpi.bankDetails, isNull);

      final withGarbage = UserModel.fromJson({
        'uid': 'uid-1',
        'bankDetails': 'not a map',
      });
      expect(withGarbage.bankDetails, isNull);

      final complete = UserModel.fromJson({
        'uid': 'uid-1',
        'bankDetails': {
          'upiId': 'asha@upi',
          'accountHolderName': 'Asha',
          'bankName': 'HDFC',
          'accountNumber': 1234567890,
          'ifscCode': 'HDFC0001',
        },
      });
      expect(complete.bankDetails, isNotNull);
      expect(complete.bankDetails!.upiId, 'asha@upi');
      expect(complete.bankDetails!.accountHolderName, 'Asha');
      expect(complete.bankDetails!.accountNumber, '1234567890');
    });
  });

  group('BankDetails.fromJson', () {
    test('reads the optional fields defensively', () {
      final details = BankDetails.fromJson({'upiId': 'a@upi'});
      expect(details.upiId, 'a@upi');
      expect(details.accountHolderName, '');
      expect(details.bankName, isNull);
      expect(details.accountNumber, isNull);
      expect(details.ifscCode, isNull);
    });
  });

  group('readableAuthError', () {
    test('uses the message of an AuthFailure', () {
      expect(
        readableAuthError(const AuthFailure('Please try again.', 'X')),
        'Please try again.',
      );
    });

    test('uses the message of any other failure', () {
      expect(
        readableAuthError(const ServerFailure('The server is busy.', 'BUSY')),
        'The server is busy.',
      );
    });

    // Firebase Auth 5.x reports a wrong e-mail *or* a wrong password with
    // `invalid-credential`. Showing the raw exception is what users
    // described as an "auth issue".
    test('explains an invalid credential', () {
      final message = readableAuthError(
        FirebaseAuthException(
          code: 'invalid-credential',
          message: 'The password is invalid or the user does not exist.',
        ),
      );
      expect(message, 'Incorrect email or password. Please try again.');
      expect(message, isNot(contains('firebase_auth')));
      expect(message, isNot(contains('invalid-credential')));
    });

    test('explains a missing account', () {
      expect(
        readableAuthError(FirebaseAuthException(code: 'user-not-found')),
        'No account found with this email.',
      );
    });

    test('explains an invalid e-mail address', () {
      expect(
        readableAuthError(FirebaseAuthException(code: 'invalid-email')),
        'Please enter a valid email address.',
      );
    });

    test('explains a disabled account', () {
      expect(
        readableAuthError(FirebaseAuthException(code: 'user-disabled')),
        'This account has been disabled.',
      );
    });

    test('shows the message of a Cloud Function error', () {
      expect(
        readableAuthError(
          FirebaseFunctionsException(
            code: 'failed-precondition',
            message: 'Verify your email address before creating your account',
          ),
        ),
        'Verify your email address before creating your account',
      );
    });

    test('explains a Firestore permission error', () {
      expect(
        readableAuthError(
          FirebaseException(
            plugin: 'cloud_firestore',
            code: 'permission-denied',
            message: 'Missing or insufficient permissions.',
          ),
        ),
        'You do not have permission to perform this action.',
      );
    });

    test('strips the noise of a plain exception', () {
      expect(
        readableAuthError(Exception('type Null is not a subtype of String')),
        'type Null is not a subtype of String',
      );
      expect(
        readableAuthError(
          Exception('[firebase_auth/too-many-requests] Too many attempts.'),
        ),
        'Too many attempts.',
      );
    });
  });

  group('LaunchPincodeConfig', () {
    // This is the exact shape of the `publicSettings/launch` document that
    // the app reads on every start, before anybody is signed in.
    test('reads the document that is stored in Firestore', () {
      final config = LaunchPincodeConfig.fromJson({
        'enabledPincodes': ['272154', '560001'],
        'disabledPincodes': <String>[],
        'mode': 'whitelist',
        'updatedAt': Timestamp.fromDate(DateTime.utc(2026, 11, 12)),
      });

      expect(config.configured, isTrue);
      expect(config.mode, 'whitelist');
      expect(config.enabledPincodes, ['272154', '560001']);
      expect(config.allows('272154'), isTrue);
      expect(config.allows('560001'), isTrue);
      expect(config.allows('110001'), isFalse);
    });

    test('an existing but empty document still counts as configured', () {
      final config = LaunchPincodeConfig.fromJson({
        'enabledPincodes': <String>[],
        'mode': 'whitelist',
      });
      expect(config.configured, isTrue);
      expect(config.allows('560001'), isFalse);
    });

    test('an unknown mode falls back to the whitelist', () {
      final config = LaunchPincodeConfig.fromJson({
        'mode': 'something-else',
        'enabledPincodes': ['560001'],
      });
      expect(config.mode, 'whitelist');
      expect(config.allows('560001'), isTrue);
      expect(config.allows('110001'), isFalse);
    });

    test('survives a completely broken document', () {
      final config = LaunchPincodeConfig.fromJson({
        'enabledPincodes': 'not a list',
        'disabledPincodes': 42,
        'mode': null,
      });
      expect(config.configured, isTrue);
      expect(config.enabledPincodes, isEmpty);
      expect(config.disabledPincodes, isEmpty);
      expect(config.mode, 'whitelist');
    });

    // The launch gate compares the pincode of the device with the list the
    // admin saved. The two come from different places (the geocoder writes
    // "560 001", the admin's text field writes "560001"), so they have to
    // be normalised before they are compared — otherwise a user is told
    // that StayServe does not run in their area while it plainly does.
    test('normalises the pincode before comparing', () {
      expect(LaunchPincodeConfig.normalise(' 560 001 '), '560001');
      expect(LaunchPincodeConfig.normalise('560-001'), '560001');
      expect(LaunchPincodeConfig.normalise('560001'), '560001');
      expect(LaunchPincodeConfig.normalise(null), '');
      expect(LaunchPincodeConfig.normalise(''), '');
    });

    test('allows a pincode that is written differently', () {
      final config = LaunchPincodeConfig.fromJson({
        'enabledPincodes': ['560001'],
        'mode': 'whitelist',
      });
      expect(config.allows(' 560 001 '), isTrue);
      expect(config.allows('560001'), isTrue);
      expect(config.allows('560038'), isFalse);
    });

    test('the blacklist mode blocks the listed pincodes only', () {
      final config = LaunchPincodeConfig.fromJson({
        'enabledPincodes': <String>[],
        'disabledPincodes': ['94043'],
        'mode': 'blacklist',
      });
      expect(config.mode, 'blacklist');
      expect(config.allows('560001'), isTrue);
      expect(config.allows('94043'), isFalse);
      expect(config.allows(' 94043 '), isFalse);
    });

    // An unconfigured app must let everybody in — otherwise a fresh install
    // locks every user out and there is no way to switch the launch areas
    // on again.
    test('an unconfigured app lets everybody in', () {
      const config = LaunchPincodeConfig();
      expect(config.configured, isFalse);
      expect(config.allows('560001'), isTrue);
      expect(config.allows('94043'), isTrue);
    });
  });
}
