import 'package:flutter_test/flutter_test.dart';
import 'package:stayserve/core/utils/safe_document_parser.dart';
import 'package:stayserve/models/join_request_model.dart';
import 'package:stayserve/models/payment_model.dart';

void main() {
  group('malformed financial documents', () {
    test('a join request ignores wrong-typed optional fields', () {
      final request = JoinRequestModel.fromJson({
        'requestId': 123,
        'roomId': false,
        'studentId': [],
        'ownerId': {},
        'status': 'pending',
        'rejectionReason': 42,
        'monthlyRentAtJoin': '5000',
        'commissionPercentageAtJoin': 'thirty',
        'invoiceId': 99,
        'advancePaid': 'yes',
        'advanceAmount': '1500',
        'advancePaymentReference': 7,
        'advancePaymentMethod': [],
        'advanceUpiTransactionId': {},
        'platformCutTaken': 'true',
        'platformFeePayer': 12,
      });

      expect(request.requestId, isEmpty);
      expect(request.roomId, isEmpty);
      expect(request.rejectionReason, isNull);
      expect(request.monthlyRentAtJoin, 0);
      expect(request.commissionPercentageAtJoin, 0);
      expect(request.invoiceId, isNull);
      expect(request.advancePaid, isFalse);
      expect(request.advanceAmount, isNull);
      expect(request.advancePaymentReference, isNull);
      expect(request.platformCutTaken, isFalse);
      expect(request.platformFeePayer, 'owner');
    });

    test('a commission invoice ignores wrong-typed fields', () {
      final invoice = CommissionInvoiceModel.fromJson({
        'invoiceId': 123,
        'roomId': false,
        'ownerId': [],
        'tenantId': {},
        'joinRequestId': 9,
        'monthlyRent': '5000',
        'commissionPercentage': 'thirty',
        'commissionAmount': '1500',
        'status': 'pending',
        'paymentReference': 42,
        'paymentMethod': [],
        'upiTransactionId': {},
      });

      expect(invoice.invoiceId, isEmpty);
      expect(invoice.monthlyRent, 0);
      expect(invoice.commissionPercentage, 0);
      expect(invoice.commissionAmount, 0);
      expect(invoice.paymentReference, isNull);
      expect(invoice.paymentMethod, isNull);
      expect(invoice.upiTransactionId, isNull);
    });

    test('a payment ignores wrong-typed fields', () {
      final payment = PaymentModel.fromJson({
        'requestId': 123,
        'studentId': false,
        'ownerId': [],
        'roomId': {},
        'amount': '1500',
        'feePercentage': 'thirty',
        'reference': 42,
        'method': [],
        'payeeVpa': {},
        'status': 99,
        'verifiedBy': 7,
        'note': [],
      }, 'PAY-1');

      expect(payment.requestId, isEmpty);
      expect(payment.amount, 0);
      expect(payment.feePercentage, 0);
      expect(payment.reference, isEmpty);
      expect(payment.method, 'upi');
      expect(payment.payeeVpa, isEmpty);
      expect(payment.status.name, 'submitted');
      expect(payment.verifiedBy, isNull);
      expect(payment.note, isNull);
    });

    test('one parser failure does not discard the valid documents', () {
      final errors = <String>[];

      final requests = parseDocumentsSafely(
        <DocumentData>[
          (id: 'broken', data: {'requestId': 123}),
          (id: 'valid', data: {'requestId': 'JRQ-VALID'}),
        ],
        (id, data) {
          if (id == 'broken') throw const FormatException('malformed request');
          return JoinRequestModel.fromJson(data);
        },
        onError: (id, _) => errors.add(id),
      );

      expect(requests, hasLength(1));
      expect(requests.single.requestId, 'JRQ-VALID');
      expect(errors, ['broken']);
    });
  });
}
