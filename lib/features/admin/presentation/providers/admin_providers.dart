import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/constants/enums.dart';
import '../../../../firebase/admin/admin_repository.dart';
import '../../../../firebase/payments/payment_repository.dart';
import '../../../../models/user_model.dart';
import '../../../../models/room_model.dart';
import '../../../../models/join_request_model.dart';
import '../../../../models/launch_pincode_config.dart';
import '../../../../models/payment_model.dart';

final adminUsersProvider = StreamProvider.autoDispose.family<List<UserModel>, UserRole?>((ref, roleFilter) {
  return ref.watch(adminRepositoryProvider).watchAllUsers(roleFilter: roleFilter);
});

final adminRoomsProvider = StreamProvider.autoDispose.family<List<RoomModel>, RoomStatus?>((ref, statusFilter) {
  return ref.watch(adminRepositoryProvider).watchAllRooms(statusFilter: statusFilter);
});

final adminJoinRequestsProvider = StreamProvider.autoDispose.family<List<JoinRequestModel>, JoinRequestStatus?>((ref, statusFilter) {
  return ref.watch(adminRepositoryProvider).watchAllJoinRequests(statusFilter: statusFilter);
});

final adminInvoicesProvider = StreamProvider.autoDispose.family<List<CommissionInvoiceModel>, InvoiceStatus?>((ref, statusFilter) {
  return ref.watch(adminRepositoryProvider).watchAllInvoices(statusFilter: statusFilter);
});

/// Platform-fee payments, optionally filtered by status.
///
/// The `payments` collection is written exclusively by the payment cloud
/// functions, so an admin is the only role that can read the whole list.
final adminPaymentsProvider = StreamProvider.autoDispose.family<List<PaymentModel>, PaymentStatus?>((ref, statusFilter) {
  return ref.watch(paymentRepositoryProvider).watchPayments(status: statusFilter);
});

final adminStatsProvider = StreamProvider.autoDispose<AdminStats>((ref) {
  return ref.watch(adminRepositoryProvider).watchStats();
});

/// The **most recent** booking requests — the "recent activity" of the
/// dashboard.
///
/// Only the newest few are read, so the dashboard stays cheap.
final adminRecentRequestsProvider =
    StreamProvider.autoDispose<List<AdminRecentRequest>>((ref) {
  return ref.watch(adminRepositoryProvider).watchRecentRequests(limit: 4);
});

final adminStatsFutureProvider = FutureProvider<AdminStats>((ref) {
  return ref.watch(adminRepositoryProvider).getStats();
});

final adminCommissionPercentageProvider = FutureProvider<double>((ref) {
  return ref.watch(adminRepositoryProvider).getCommissionPercentage();
});

final adminMaintenanceModeProvider = FutureProvider<bool>((ref) {
  return ref.watch(adminRepositoryProvider).getMaintenanceMode();
});

final adminNotificationsEnabledProvider = FutureProvider<bool>((ref) {
  return ref.watch(adminRepositoryProvider).getNotificationsEnabled();
});

/// Who settles the platform fee — `owner` or `student`.
final adminFeePayerProvider = FutureProvider<String>((ref) {
  return ref.watch(adminRepositoryProvider).getFeePayer();
});

final adminLaunchPincodeConfigProvider = StreamProvider.autoDispose<LaunchPincodeConfig>((ref) {
  return ref.watch(adminRepositoryProvider).watchLaunchPincodeConfig();
});

final adminLaunchPincodeConfigFutureProvider = FutureProvider<LaunchPincodeConfig>((ref) {
  return ref.watch(adminRepositoryProvider).getLaunchPincodeConfig();
});

final adminControllerProvider = AsyncNotifierProvider<AdminController, void>(() {
  return AdminController();
});

/// Runs the admin actions.
///
/// Every method returns the error message when the action failed (and
/// `null` when it worked). The screens show that message in a snack bar —
/// the errors used to be swallowed, so a failed ban or a failed approval
/// looked exactly like a successful one.
class AdminController extends AsyncNotifier<void> {
  @override
  Future<void> build() async {}

  /// Runs [action] and returns the error message, if any.
  Future<String?> _run(Future<void> Function() action) async {
    state = const AsyncLoading();
    try {
      await action();
      state = const AsyncData(null);
      return null;
    } catch (e) {
      state = AsyncError(e, StackTrace.current);
      final message = e is Exception
          ? e.toString().replaceFirst('Exception: ', '').trim()
          : 'Something went wrong';
      return message.isEmpty ? 'Something went wrong' : message;
    }
  }

  Future<String?> toggleUserActive(String uid, bool isActive) async {
    final error = await _run(
      () => ref.read(adminRepositoryProvider).toggleUserActive(uid, isActive),
    );
    if (error == null) {
      ref.invalidate(adminUsersProvider);
    }
    return error;
  }

  Future<String?> updateUserRole(String uid, UserRole newRole) async {
    final error = await _run(
      () => ref.read(adminRepositoryProvider).updateUserRole(uid, newRole),
    );
    if (error == null) {
      ref.invalidate(adminUsersProvider);
    }
    return error;
  }

  Future<String?> deleteUser(String uid) async {
    final error = await _run(
      () => ref.read(adminRepositoryProvider).deleteUser(uid),
    );
    if (error == null) {
      ref.invalidate(adminUsersProvider);
    }
    return error;
  }

  /// Schedules the deletion of an account — with a grace period.
  ///
  /// The account is not deleted right away: the user gets [days] (seven
  /// by default) before the scheduled job removes it, and the deletion can
  /// still be cancelled in the meantime.
  Future<String?> scheduleUserDeletion(String uid, {int days = 7}) async {
    final error = await _run(
      () => ref
          .read(adminRepositoryProvider)
          .scheduleUserDeletion(uid, days: days),
    );
    if (error == null) {
      ref.invalidate(adminUsersProvider);
    }
    return error;
  }

  /// Cancels a scheduled deletion and re-enables the account.
  Future<String?> cancelUserDeletion(String uid) async {
    final error = await _run(
      () => ref.read(adminRepositoryProvider).cancelUserDeletion(uid),
    );
    if (error == null) {
      ref.invalidate(adminUsersProvider);
    }
    return error;
  }

  Future<String?> banUser(String uid, {String? reason}) async {
    final error = await _run(
      () => ref.read(adminRepositoryProvider).banUser(uid, reason: reason),
    );
    if (error == null) {
      ref.invalidate(adminUsersProvider);
    }
    return error;
  }

  Future<String?> unbanUser(String uid) async {
    final error = await _run(
      () => ref.read(adminRepositoryProvider).unbanUser(uid),
    );
    if (error == null) {
      ref.invalidate(adminUsersProvider);
    }
    return error;
  }

  Future<String?> updateRoomStatus(String roomId, RoomStatus status) async {
    final error = await _run(
      () => ref.read(adminRepositoryProvider).updateRoomStatus(roomId, status),
    );
    if (error == null) {
      ref.invalidate(adminRoomsProvider);
    }
    return error;
  }

  Future<String?> deleteRoom(String roomId) async {
    final error = await _run(
      () => ref.read(adminRepositoryProvider).deleteRoom(roomId),
    );
    if (error == null) {
      ref.invalidate(adminRoomsProvider);
    }
    return error;
  }

  Future<String?> adminReviewRequest(
    String requestId, {
    required bool approve,
    String? rejectionReason,
  }) async {
    final error = await _run(
      () => ref.read(adminRepositoryProvider).adminReviewRequest(
        requestId,
        approve: approve,
        rejectionReason: rejectionReason,
      ),
    );
    if (error == null) {
      ref.invalidate(adminJoinRequestsProvider);
      ref.invalidate(adminInvoicesProvider);
      ref.invalidate(adminStatsProvider);
    }
    return error;
  }

  Future<String?> markInvoicePaid(
    String invoiceId, {
    String? paymentReference,
    String? paymentMethod,
    String? upiTransactionId,
  }) async {
    final error = await _run(
      () => ref.read(adminRepositoryProvider).markInvoicePaid(
        invoiceId,
        paymentReference: paymentReference,
        paymentMethod: paymentMethod,
        upiTransactionId: upiTransactionId,
      ),
    );
    if (error == null) {
      ref.invalidate(adminInvoicesProvider);
      ref.invalidate(adminStatsProvider);
    }
    return error;
  }

  Future<String?> cancelInvoice(String invoiceId) async {
    final error = await _run(
      () => ref.read(adminRepositoryProvider).cancelInvoice(invoiceId),
    );
    if (error == null) {
      ref.invalidate(adminInvoicesProvider);
      ref.invalidate(adminStatsProvider);
    }
    return error;
  }

  Future<String?> updateCommissionPercentage(double percentage) async {
    final error = await _run(
      () => ref
          .read(adminRepositoryProvider)
          .updateCommissionPercentage(percentage),
    );
    if (error == null) {
      // The slider kept showing the old value because the provider was
      // never invalidated.
      ref.invalidate(adminCommissionPercentageProvider);
    }
    return error;
  }

  Future<String?> setMaintenanceMode(bool enabled) async {
    final error = await _run(
      () => ref.read(adminRepositoryProvider).setMaintenanceMode(enabled),
    );
    if (error == null) {
      // Same here — the switch kept showing the state from before the save.
      ref.invalidate(adminMaintenanceModeProvider);
    }
    return error;
  }

  Future<String?> setNotificationsEnabled(bool enabled) async {
    final error = await _run(
      () => ref.read(adminRepositoryProvider).setNotificationsEnabled(enabled),
    );
    if (error == null) {
      ref.invalidate(adminNotificationsEnabledProvider);
    }
    return error;
  }

  /// Switches between "the owner pays the platform fee" and "the student
  /// pays the platform fee".
  Future<String?> setFeePayer(String payer) async {
    final error = await _run(
      () => ref.read(adminRepositoryProvider).setFeePayer(payer),
    );
    if (error == null) {
      ref.invalidate(adminFeePayerProvider);
    }
    return error;
  }

  /// Runs one of the server-side maintenance tasks (`cleanNotifications` /
  /// `archiveRooms`).
  Future<String?> runMaintenanceTask(String task) async {
    return _run(() => ref.read(adminRepositoryProvider).runMaintenanceTask(task));
  }

  Future<String?> updateLaunchPincodeConfig({
    required List<String> enabledPincodes,
    required List<String> disabledPincodes,
    required String mode,
  }) async {
    final error = await _run(
      () => ref.read(adminRepositoryProvider).updateLaunchPincodeConfig(
        enabledPincodes: enabledPincodes,
        disabledPincodes: disabledPincodes,
        mode: mode,
      ),
    );
    if (error == null) {
      ref.invalidate(adminLaunchPincodeConfigProvider);
      ref.invalidate(adminLaunchPincodeConfigFutureProvider);
    }
    return error;
  }
}