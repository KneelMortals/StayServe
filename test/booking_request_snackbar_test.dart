// Regression tests for the message bar which follows the booking request.
//
// A snack bar which carries an action **persists** by default: it stays on
// the screen until the action is pressed. The bar of the room screen floats
// above the keyboard of the **next** screen as well, so it covered the
// message composer of the chat and swallowed every tap of the user on
// "Send" — without any visible reaction.
//
// The tests below prove that the bar of a sent request disappears on its
// own and that its action still leads to the list of the requests.

import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';

import 'package:stayserve/core/index.dart';

void main() {
  group('the message bar of a sent booking request', () {
    testWidgets('disappears on its own instead of covering the next screen', (
      tester,
    ) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () => ScaffoldMessenger.of(context).showSnackBar(
                  bookingRequestSentSnackBar(
                    onViewRequests: () => Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (_) => const Scaffold(body: Text('requests')),
                      ),
                    ),
                  ),
                ),
                child: const Text('send'),
              ),
            ),
          ),
        ),
      );

      await tester.tap(find.text('send'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));

      expect(
        find.textContaining('Request sent!'),
        findsOneWidget,
        reason: 'the student must see that the request went through',
      );

      // The bar must not outlive its own duration.
      await tester.pump(const Duration(seconds: 9));
      await tester.pump(const Duration(milliseconds: 400));

      expect(
        find.textContaining('Request sent!'),
        findsNothing,
        reason:
            'a bar which stays on the screen covers the composer of the '
            'following screen and swallows the taps of the user',
      );
    });

    testWidgets('the action still opens the list of the requests', (
      tester,
    ) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => TextButton(
                onPressed: () => ScaffoldMessenger.of(context).showSnackBar(
                  bookingRequestSentSnackBar(
                    onViewRequests: () => Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (_) => const Scaffold(body: Text('requests')),
                      ),
                    ),
                  ),
                ),
                child: const Text('send'),
              ),
            ),
          ),
        ),
      );

      await tester.tap(find.text('send'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));

      await tester.tap(find.text('View requests'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));

      expect(find.text('requests'), findsOneWidget);
    });

    test('does not persist', () {
      final bar = bookingRequestSentSnackBar(onViewRequests: () {});
      expect(bar.persist, isFalse);
      expect(bar.duration, isNotNull);
      expect(bar.action, isNotNull);
    });
  });
}
