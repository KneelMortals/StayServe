import 'package:flutter_test/flutter_test.dart';
import 'package:stayserve/firebase/admin/admin_repository.dart';

void main() {
  group('account-deletion result', () {
    test('parses a completed deletion', () {
      final result = AccountDeletionResult.fromData({
        'completed': true,
        'queued': false,
        'blocked': false,
        'retryable': false,
        'state': 'completed',
        'message': 'User deleted completely',
      });

      expect(result.completed, isTrue);
      expect(result.queued, isFalse);
      expect(result.blocked, isFalse);
      expect(result.retryable, isFalse);
      expect(result.state, 'completed');
    });

    test('keeps a blocked deletion distinct from a retryable one', () {
      final result = AccountDeletionResult.fromData({
        'completed': false,
        'queued': true,
        'blocked': true,
        'retryable': false,
        'state': 'blocked',
        'message': 'Active booking data still exists',
      });

      expect(result.completed, isFalse);
      expect(result.queued, isTrue);
      expect(result.blocked, isTrue);
      expect(result.retryable, isFalse);
      expect(result.state, 'blocked');
      expect(result.message, contains('Active booking'));
    });

    test('marks a transient failure as queued and retryable', () {
      final result = AccountDeletionResult.fromData({
        'completed': false,
        'queued': true,
        'blocked': false,
        'retryable': true,
        'state': 'queued',
        'message': 'The deletion will be retried',
      });

      expect(result.queued, isTrue);
      expect(result.blocked, isFalse);
      expect(result.retryable, isTrue);
      expect(result.state, 'queued');
    });

    test('fails closed for an incomplete response', () {
      final result = AccountDeletionResult.fromData(const {});

      expect(result.completed, isFalse);
      expect(result.blocked, isFalse);
      expect(result.queued, isTrue);
      expect(result.retryable, isTrue);
      expect(result.state, 'queued');
    });
  });
}
