// Tests for the merge of two streams.
//
// The owner's room list watches the published listings and the unfinished
// drafts separately. The merge has to behave like a "latest of both" stream:
// it emits whenever one of the sources emits, it waits for both sources
// before it emits the first time, and it can be re-listened after it was
// cancelled.

import 'dart:async';

import 'package:flutter_test/flutter_test.dart';

import 'package:stayserve/core/utils/combine_latest.dart';

void main() {
  test('the merge waits for both sources before it emits', () async {
    final first = StreamController<int>();
    final second = StreamController<String>();

    final values = <String>[];
    final subscription = combineLatest2<int, String, String>(
      first.stream,
      second.stream,
      (a, b) => '$a/$b',
    ).listen(values.add);

    first.add(1);
    await Future<void>.delayed(Duration.zero);
    expect(values, isEmpty, reason: 'the second source has not spoken yet');

    second.add('a');
    await Future<void>.delayed(Duration.zero);
    expect(values, <String>['1/a']);

    // Every later value of either source is merged with the latest value of
    // the other one.
    first.add(2);
    await Future<void>.delayed(Duration.zero);
    expect(values, <String>['1/a', '2/a']);

    second.add('b');
    await Future<void>.delayed(Duration.zero);
    expect(values, <String>['1/a', '2/a', '2/b']);

    await subscription.cancel();
    await first.close();
    await second.close();
  });

  test('the merge can be listened to again after it was cancelled', () async {
    final first = StreamController<int>.broadcast();
    final second = StreamController<String>.broadcast();

    final merged = combineLatest2<int, String, String>(
      first.stream,
      second.stream,
      (a, b) => '$a/$b',
    );

    final firstRun = <String>[];
    final firstSubscription = merged.listen(firstRun.add);
    first.add(1);
    second.add('a');
    await Future<void>.delayed(Duration.zero);
    expect(firstRun, <String>['1/a']);
    await firstSubscription.cancel();

    // A provider which rebuilds its subscription listens to the same stream
    // again. A single-subscription stream would refuse this.
    final secondRun = <String>[];
    final secondSubscription = merged.listen(secondRun.add);
    first.add(2);
    second.add('b');
    await Future<void>.delayed(Duration.zero);
    expect(secondRun, <String>['2/b']);
    await secondSubscription.cancel();

    await first.close();
    await second.close();
  });
}
