import 'package:flutter_test/flutter_test.dart';

import 'package:stayserve/core/routing/navigation_history.dart';

void main() {
  group('the navigation history', () {
    test('remembers the pages the user visited', () {
      final history = NavigationHistory();

      expect(history.previous, isNull);
      expect(history.canGoBack, isFalse);

      history.record('/student/home');
      expect(history.previous, isNull);
      expect(history.canGoBack, isFalse);

      history.record('/student/search');
      expect(history.previous, '/student/home');
      expect(history.canGoBack, isTrue);

      history.record('/room/room-1');
      expect(history.previous, '/student/search');
    });

    test('does not remember the same page twice', () {
      final history = NavigationHistory();

      history.record('/student/home');
      history.record('/student/home');
      history.record('/student/search');
      history.record('/student/search');

      expect(history.locations, ['/student/home', '/student/search']);
    });

    test(
      'going back returns the previous page and forgets the current one',
      () {
        final history = NavigationHistory()
          ..record('/student/home')
          ..record('/student/search');

        expect(history.back(), '/student/home');
        expect(history.locations, ['/student/home']);
        expect(history.canGoBack, isFalse);
        expect(history.back(), isNull);
      },
    );

    test('does not grow without bound', () {
      final history = NavigationHistory();

      for (var i = 0; i < NavigationHistory.maxEntries + 10; i++) {
        history.record('/page/$i');
      }

      expect(history.locations.length, NavigationHistory.maxEntries);
      // The oldest pages are the ones that are forgotten.
      expect(history.locations.first, '/page/10');
    });

    test('can be thrown away', () {
      final history = NavigationHistory()
        ..record('/student/home')
        ..record('/student/search');

      history.clear();

      expect(history.locations, isEmpty);
      expect(history.canGoBack, isFalse);
      expect(history.back(), isNull);
    });

    test('the pages of the sign-in flow are not part of the history', () {
      final history = NavigationHistory();

      // The user is on the login screen and opens the registration.
      history.record('/login');
      history.record('/register');
      expect(history.previous, '/login');

      // The user signs in — the app starts a new history.
      history.record('/student/home');
      expect(history.locations, ['/student/home']);
      expect(history.previous, isNull);
      expect(history.canGoBack, isFalse);
    });

    test('the pages of the old session are dropped after a sign-out', () {
      final history = NavigationHistory();

      history.record('/student/home');
      history.record('/student/search');
      // The sign-out sends the user to the login screen.
      history.record('/login');
      // … and the sign-in back to the dashboard.
      history.record('/student/home');

      expect(history.locations, ['/student/home']);
    });
  });
}
