// Tests for the **UPI intent**.
//
// The rule the app has to follow:
//
//   * the intent stays inside the limits of the UPI specification,
//   * the payee address is written the canonical way — `name@bank` and
//     **not** `name%40bank`.
//
// ## Why the address matters
//
// Several UPI apps (Paytm and some versions of the BHIM app) read the
// query of the intent by hand instead of decoding it. With an encoded
// address they see `name%40bank`, do not recognise the address and refuse
// the payment with a message that has nothing to do with the real reason —
// "the amount exceeds the limit", "the transaction cannot be completed".
// The amount was fine; the *address* was the problem.

import 'package:flutter_test/flutter_test.dart';

import 'package:stayserve/services/payment_service.dart';

void main() {
  group('the canonical UPI intent', () {
    test('writes the payee address without encoding it', () {
      final uri = UpiIntentBuilder.build(
        payeeVpa: 'shauryaprataprai461-2@oksbi',
        payeeName: 'StayServe',
        amount: 133,
        transactionRef: 'SS131F3A66A7EE',
        transactionNote: 'StayServe fee JRQ-3D8E131F3A66A7EE',
      );

      expect(uri, contains('pa=shauryaprataprai461-2@oksbi'));
      expect(uri, isNot(contains('%40')));
    });

    test('encodes the values that need it', () {
      final uri = UpiIntentBuilder.build(
        payeeVpa: 'shauryaprataprai461-2@oksbi',
        payeeName: 'StayServe',
        amount: 133,
        transactionRef: 'SS131F3A66A7EE',
        transactionNote: 'StayServe fee JRQ-3D8E131F3A66A7EE',
      );

      // A space is written as `%20` — and **not** as `+`, which not every
      // UPI app decodes as a space.
      expect(uri, contains('tn=StayServe%20fee'));
      expect(uri, isNot(contains('+')));
    });

    test('carries the amount, the currency and the reference', () {
      final uri = UpiIntentBuilder.build(
        payeeVpa: 'shauryaprataprai461-2@oksbi',
        payeeName: 'StayServe',
        amount: 133,
        transactionRef: 'SS131F3A66A7EE',
        transactionNote: 'StayServe fee',
      );

      final parsed = Uri.parse(uri);
      expect(parsed.scheme, 'upi');
      expect(parsed.queryParameters['am'], '133.00');
      expect(parsed.queryParameters['cu'], 'INR');
      expect(parsed.queryParameters['tr'], 'SS131F3A66A7EE');
      expect(parsed.queryParameters['pa'], 'shauryaprataprai461-2@oksbi');
      expect(parsed.queryParameters['pn'], 'StayServe');
    });

    test('stays inside the limits of the specification', () {
      final uri = UpiIntentBuilder.build(
        payeeVpa: '${'a' * 98}@x${'b' * 200}',
        payeeName: 'b' * 200,
        amount: double.parse('123456789012345678'),
        transactionRef: 'c' * 200,
        transactionNote: 'd' * 200,
      );

      final params = Uri.parse(uri).queryParameters;
      expect(params['pa']!.length, UpiIntentLimits.payeeAddress);
      expect(params['pn']!.length, UpiIntentLimits.payeeName);
      expect(params['am']!.length, UpiIntentLimits.amount);
      expect(params['tr']!.length, UpiIntentLimits.transactionRef);
      expect(params['tn']!.length, UpiIntentLimits.transactionNote);

      expect(UpiIntentValidator.validate(uri), isNull);
    });

    test('repairs the intent of an older server', () {
      // What the server used to send.
      const serverUri =
          'upi://pay?pa=shauryaprataprai461-2%40oksbi&pn=StayServe&am=133.00'
          '&cu=INR&tr=SS131F3A66A7EE&tn=StayServe%20fee%20JRQ-3D8E131F3A66A7EE';

      final canonical = UpiIntentBuilder.canonicalise(
        serverUri,
        payeeVpa: 'shauryaprataprai461-2@oksbi',
        payeeName: 'StayServe',
        amount: 133,
        transactionRef: 'SS131F3A66A7EE',
      );

      expect(canonical, isNotNull);
      expect(canonical, contains('pa=shauryaprataprai461-2@oksbi'));
      expect(canonical, isNot(contains('%40')));
      // Everything else is kept.
      expect(
        Uri.parse(canonical!).queryParameters['tn'],
        'StayServe fee JRQ-3D8E131F3A66A7EE',
      );
      expect(Uri.parse(canonical).queryParameters['am'], '133.00');
    });

    test('keeps the intent of the server when it is not a UPI link', () {
      expect(
        UpiIntentBuilder.canonicalise(
          'https://example.com/pay',
          payeeVpa: 'shauryaprataprai461-2@oksbi',
          payeeName: 'StayServe',
          amount: 133,
          transactionRef: 'SS131F3A66A7EE',
        ),
        isNull,
      );
    });
  });

  group('the UPI intent validator', () {
    test('accepts the canonical intent', () {
      final uri = UpiIntentBuilder.build(
        payeeVpa: 'shauryaprataprai461-2@oksbi',
        payeeName: 'StayServe',
        amount: 133,
        transactionRef: 'SS131F3A66A7EE',
        transactionNote: 'StayServe fee',
      );

      expect(UpiIntentValidator.validate(uri), isNull);
    });

    test('names the parameter that breaks the limit', () {
      final uri =
          'upi://pay?pa=shauryaprataprai461-2@oksbi&pn=StayServe&am=133.00'
          '&cu=INR&tr=SS131F3A66A7EE'
          '&tn=${'x' * 80}';

      final problem = UpiIntentValidator.validate(uri);
      expect(problem, isNotNull);
      expect(problem, contains('transaction note'));
      expect(problem, contains('the limit is 50'));
    });

    test('rejects an address without a bank', () {
      const uri =
          'upi://pay?pa=shauryaprataprai461-2&pn=StayServe&am=133.00&cu=INR';

      expect(UpiIntentValidator.validate(uri), contains('valid UPI address'));
    });

    test('rejects a link that is not a UPI link', () {
      expect(
        UpiIntentValidator.validate('https://example.com'),
        contains('not a UPI link'),
      );
    });
  });
}
