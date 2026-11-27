import 'dart:async';

/// Merges the latest values of two streams into one.
///
/// The merged stream emits whenever one of the sources emits. It waits until
/// **both** sources have produced a value for the first time, so a consumer
/// never sees a half-populated result.
///
/// The merge is used for the owner's room list: the published listings and
/// the unfinished drafts live in two owner-scoped collections, and the owner
/// has to see both.
///
/// Every listener gets its own subscription to the two sources, so the
/// merged stream can be re-listened after it was cancelled. A provider which
/// rebuilds its subscription therefore never runs into a "stream has already
/// been listened to" error.
Stream<R> combineLatest2<A, B, R>(
  Stream<A> first,
  Stream<B> second,
  R Function(A first, B second) combine,
) {
  return Stream.multi((controller) {
    A? latestFirst;
    B? latestSecond;
    var hasFirst = false;
    var hasSecond = false;

    void publish() {
      if (!hasFirst || !hasSecond || controller.isClosed) return;
      controller.add(combine(latestFirst as A, latestSecond as B));
    }

    final firstSubscription = first.listen((value) {
      latestFirst = value;
      hasFirst = true;
      publish();
    }, onError: controller.addError);
    final secondSubscription = second.listen((value) {
      latestSecond = value;
      hasSecond = true;
      publish();
    }, onError: controller.addError);

    controller.onCancel = () async {
      await firstSubscription.cancel();
      await secondSubscription.cancel();
    };
  });
}
