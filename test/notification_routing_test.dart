import 'package:flutter_test/flutter_test.dart';

import 'package:stayserve/core/constants/enums.dart';
import 'package:stayserve/models/notification_model.dart';

/// The notifications of the app and the screen they have to open.
///
/// The notifications used to point at a screen of **one** role: an invoice
/// notification always led to `/owner/invoices`, so a student who tapped it
/// was bounced back to their home by the router — the tap looked like it
/// did nothing at all.
void main() {
  group('the route of a notification', () {
    test('a join request opens the request list of the owner', () {
      expect(
        notificationRouteFor(
          type: 'joinRequest',
          data: const {'requestId': 'JRQ-1', 'roomId': 'RM-1'},
          role: UserRole.owner,
        ),
        '/owner/requests',
      );
    });

    test('a join request opens the request list of the student', () {
      expect(
        notificationRouteFor(
          type: 'joinRequest',
          data: const {'requestId': 'JRQ-1', 'roomId': 'RM-1'},
          role: UserRole.student,
        ),
        '/student/requests',
      );
    });

    test('a confirmed booking asks the student for the payment', () {
      expect(
        notificationRouteFor(
          type: 'joinConfirmed',
          data: const {'requestId': 'JRQ-1'},
          role: UserRole.student,
        ),
        '/student/requests',
      );
    });

    test('an invoice opens the invoice list of the owner', () {
      expect(
        notificationRouteFor(
          type: 'invoicePaid',
          data: const {'requestId': 'JRQ-1'},
          role: UserRole.owner,
        ),
        '/owner/invoices',
      );
    });

    test('an invoice opens the request list of the student', () {
      // The student has no invoice tab — the payment belongs to the
      // booking.
      expect(
        notificationRouteFor(
          type: 'invoicePaid',
          data: const {'requestId': 'JRQ-1'},
          role: UserRole.student,
        ),
        '/student/requests',
      );
    });

    test('an invoice with an id opens the invoice itself', () {
      expect(
        notificationRouteFor(
          type: 'invoicePaid',
          data: const {'invoiceId': 'INV-1'},
          role: UserRole.owner,
        ),
        '/invoice/INV-1',
      );
    });

    test('a message opens the conversation', () {
      expect(
        notificationRouteFor(
          type: 'newMessage',
          data: const {'conversationId': 'C-1'},
          role: UserRole.student,
        ),
        '/chat/C-1',
      );
      expect(
        notificationRouteFor(
          type: 'newMessage',
          data: const {},
          role: UserRole.student,
        ),
        '/conversations',
      );
    });

    test('the admin is sent to the requests he has to review', () {
      expect(
        notificationRouteFor(
          type: 'adminReview',
          data: const {'requestId': 'JRQ-1'},
          role: UserRole.admin,
        ),
        '/admin/requests',
      );
    });

    test('every route is open to the role it belongs to', () {
      final cases = <List<Object?>>[
        ['joinRequest', UserRole.owner, '/owner'],
        ['joinRequest', UserRole.student, '/student'],
        ['invoicePaid', UserRole.owner, '/owner'],
        ['invoicePaid', UserRole.student, '/student'],
        ['adminReview', UserRole.admin, '/admin'],
      ];

      for (final entry in cases) {
        final route = notificationRouteFor(
          type: entry[0]! as String,
          data: const {'requestId': 'JRQ-1'},
          role: entry[1]! as UserRole,
        );
        expect(
          route.startsWith(entry[2]! as String),
          isTrue,
          reason: '$route has to be open to the ${entry[1]}',
        );
      }
    });
  });

  group('the notification model', () {
    NotificationModel build(NotificationType type, Map<String, dynamic> data) {
      return NotificationModel(
        notificationId: 'N-1',
        userId: 'u1',
        type: type,
        title: 'Title',
        body: 'Body',
        data: data,
        createdAt: DateTime(2026, 11, 13),
      );
    }

    test('the route depends on the role of the user', () {
      final notification = build(NotificationType.invoicePaid, const {
        'requestId': 'JRQ-1',
      });

      expect(notification.routeFor(UserRole.owner), '/owner/invoices');
      expect(notification.routeFor(UserRole.student), '/student/requests');
    });

    test('the unknown types do not break the model', () {
      final notification = NotificationModel.fromJson({
        'notificationId': 'N-1',
        'userId': 'u1',
        'type': 'somethingNew',
        'title': 'Title',
        'body': 'Body',
        'data': <String, dynamic>{},
        'createdAt': DateTime(2026, 11, 13).toIso8601String(),
      });

      expect(notification.type, NotificationType.general);
      expect(notification.routeFor(UserRole.student), '/student/home');
    });

    test('the account notifications are known', () {
      final notification = NotificationModel.fromJson({
        'notificationId': 'N-1',
        'userId': 'u1',
        'type': 'account',
        'title': 'Title',
        'body': 'Body',
        'data': <String, dynamic>{},
        'createdAt': DateTime(2026, 11, 13).toIso8601String(),
      });

      expect(notification.type, NotificationType.account);
      expect(notification.routeFor(UserRole.student), '/student/profile');
      expect(notification.routeFor(UserRole.owner), '/owner/profile');
    });
  });
}
