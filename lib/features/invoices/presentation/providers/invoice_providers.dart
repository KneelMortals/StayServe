import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../../firebase/invoices/invoice_repository.dart';
import '../../../../../models/join_request_model.dart';

final invoiceProvider =
    StreamProvider.autoDispose.family<CommissionInvoiceModel?, String>((ref, invoiceId) {
  return ref.watch(invoiceRepositoryProvider).watchInvoice(invoiceId);
});

final invoiceRoomProvider =
    StreamProvider.autoDispose.family<Map<String, dynamic>?, String>((ref, roomId) {
  return ref.watch(invoiceRepositoryProvider).watchInvoiceRoom(roomId);
});
