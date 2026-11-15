import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../models/join_request_model.dart';
import '../auth/auth_service.dart';

final invoiceRepositoryProvider = Provider<InvoiceRepository>((ref) {
  return InvoiceRepository(ref.watch(firestoreProvider));
});

/// Data access for commission invoices.
class InvoiceRepository {
  final FirebaseFirestore _firestore;

  InvoiceRepository(this._firestore);

  /// Watches a single invoice.
  Stream<CommissionInvoiceModel?> watchInvoice(String invoiceId) {
    return _firestore
        .collection('commissionInvoices')
        .doc(invoiceId)
        .snapshots()
        .map((snapshot) {
      if (!snapshot.exists) return null;
      try {
        return CommissionInvoiceModel.fromJson(snapshot.data()!);
      } catch (_) {
        return null;
      }
    });
  }

  /// Watches the room an invoice refers to.
  Stream<Map<String, dynamic>?> watchInvoiceRoom(String roomId) {
    return _firestore.collection('rooms').doc(roomId).snapshots().map((snapshot) {
      if (!snapshot.exists) return null;
      return snapshot.data();
    });
  }
}
