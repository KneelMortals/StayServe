// Regression tests for the identity of a retried room submission.
//
// The owner repository recognises a retry by the fingerprint of the
// submitted listing. The home groups the listing in the owner's list, so
// the home id is part of that fingerprint.
//
// A brand-new home used to receive a **fresh** id on every tap of the save
// button. The fingerprint therefore changed between the first attempt and
// its retry: the repository treated the retry as a new listing and created
// a **second** room under a **second** home.
//
// The id of a new home is now generated once per form session and kept for
// the whole lifetime of the form, so a retry keeps the same fingerprint and
// therefore completes the same listing.

import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:stayserve/core/widgets/common_widgets.dart';
import 'package:stayserve/features/owners/presentation/widgets/room_form.dart';
import 'package:stayserve/firebase/owner/owner_repository.dart';

/// Finds the text field which carries the given label.
Finder _field(String label) => find.byWidgetPredicate(
  (widget) => widget is AppTextField && widget.label == label,
);

/// Fills the mandatory fields of the form.
Future<void> _fillTheForm(WidgetTester tester) async {
  await tester.enterText(_field('Room Title'), 'Sunny room near the campus');
  await tester.enterText(_field('Description'), 'A comfortable room.');
  await tester.enterText(_field('Rent (₹)'), '6000');
  await tester.enterText(_field('Deposit (₹)'), '12000');
  await tester.enterText(_field('Address'), '42 Test Street');
  await tester.enterText(_field('City'), 'Bengaluru');
  await tester.enterText(_field('State'), 'Karnataka');
  await tester.enterText(_field('Pincode'), '560001');
  await tester.enterText(_field('Home name'), 'Sunrise Apartments');
  await tester.pump();
}

/// Taps the save button of the form.
///
/// The button sits at the very end of a long list, so it has to be scrolled
/// into view before it can be tapped.
Future<void> _submit(WidgetTester tester) async {
  final button = find.text('Save Listing');
  final list = find
      .descendant(of: find.byType(ListView), matching: find.byType(Scrollable))
      .first;
  await tester.scrollUntilVisible(button, 400, scrollable: list);
  await tester.pumpAndSettle();
  await tester.tap(button);
  await tester.pump();
}

void main() {
  testWidgets('a retried submission keeps the id of the new home', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1200, 3000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    var generatedIds = 0;
    final submissions = <RoomDraft>[];

    await tester.pumpWidget(
      ProviderScope(
        child: MaterialApp(
          home: Scaffold(
            body: RoomForm(
              // A deterministic factory: every call returns a new id, so a
              // form which generated the id on every submission would produce
              // two different ids.
              newHomeIdFactory: () => 'HOME-${++generatedIds}',
              onSubmit: (draft) async {
                submissions.add(draft);
                // The save fails, so the form stays open and the owner can
                // try again — exactly the situation of a lost acknowledgement.
                throw Exception('The listing could not be saved.');
              },
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await _fillTheForm(tester);
    await _submit(tester);
    await tester.pumpAndSettle();

    expect(submissions.length, 1);
    final firstHomeId = submissions.single.room.homeId;
    expect(firstHomeId, isNotNull);
    expect(firstHomeId, isNotEmpty);

    // The owner taps "Save Listing" again.
    await _submit(tester);
    await tester.pumpAndSettle();

    expect(submissions.length, 2);
    expect(
      submissions.last.room.homeId,
      firstHomeId,
      reason:
          'The retry must use the same home, otherwise it is a second '
          'listing under a second home.',
    );
    expect(submissions.last.room.homeName, submissions.first.room.homeName);

    // The id was generated exactly once for the whole form session.
    expect(generatedIds, 1);
  });

  testWidgets('a form without a home name does not invent a home', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1200, 3000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    var generatedIds = 0;
    final submissions = <RoomDraft>[];

    await tester.pumpWidget(
      ProviderScope(
        child: MaterialApp(
          home: Scaffold(
            body: RoomForm(
              newHomeIdFactory: () => 'HOME-${++generatedIds}',
              onSubmit: (draft) async {
                submissions.add(draft);
                throw Exception('The listing could not be saved.');
              },
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.enterText(_field('Room Title'), 'Sunny room near the campus');
    await tester.enterText(_field('Description'), 'A comfortable room.');
    await tester.enterText(_field('Rent (₹)'), '6000');
    await tester.enterText(_field('Deposit (₹)'), '12000');
    await tester.enterText(_field('Address'), '42 Test Street');
    await tester.enterText(_field('City'), 'Bengaluru');
    await tester.enterText(_field('State'), 'Karnataka');
    await tester.enterText(_field('Pincode'), '560001');
    await tester.pump();

    await _submit(tester);
    await tester.pumpAndSettle();

    expect(submissions.length, 1);
    expect(submissions.single.room.homeId, isNull);
    expect(submissions.single.room.homeName, isNull);
    expect(generatedIds, 0);
  });
}
