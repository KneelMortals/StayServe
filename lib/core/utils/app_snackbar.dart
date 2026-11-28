import 'package:material_ui/material_ui.dart';

/// Small helpers for showing feedback to the user.
///
/// Every admin action runs against a cloud function or a Firestore write.
/// When such an action fails the user has to be told — silently swallowing
/// the error made the admin screens look like they had worked while
/// nothing had happened at all.
extension AppSnackBarX on BuildContext {
  /// Shows an error message.
  void showErrorSnackBar(String message) {
    final messenger = ScaffoldMessenger.maybeOf(this);
    if (messenger == null) return;
    messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          content: Text(message),
          backgroundColor: Theme.of(this).colorScheme.error,
        ),
      );
  }

  /// Shows a success message.
  void showSuccessSnackBar(String message) {
    final messenger = ScaffoldMessenger.maybeOf(this);
    if (messenger == null) return;
    messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          content: Text(message),
          backgroundColor: Theme.of(this).colorScheme.primary,
        ),
      );
  }

  /// Shows a warning message.
  ///
  /// This is used for operations which were accepted but did not reach their
  /// final state — for example a deletion which is queued for a retry.
  void showWarningSnackBar(String message) {
    final messenger = ScaffoldMessenger.maybeOf(this);
    if (messenger == null) return;
    messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          content: Text(message),
          backgroundColor: Theme.of(this).colorScheme.tertiary,
        ),
      );
  }

  /// Shows the error of a failed action, if there is one.
  ///
  /// Returns `true` when an error was shown.
  bool showErrorIfAny(String? error) {
    if (error == null || error.trim().isEmpty) return false;
    showErrorSnackBar(error);
    return true;
  }
}

/// The message which tells the student that the booking request was sent.
///
/// A snack bar which carries an action **persists** by default: it stays on
/// the screen until the action is pressed. The bar of the room screen floats
/// above the keyboard of the **next** screen as well, so it covered the
/// message composer of the chat and swallowed every tap of the user on
/// "Send" — without any visible reaction. The bar therefore disappears on
/// its own.
SnackBar bookingRequestSentSnackBar({VoidCallback? onViewRequests}) {
  return SnackBar(
    content: const Text(
      'Request sent! The owner will review it. You can pay the platform fee '
      'once they approve.',
    ),
    backgroundColor: Colors.green,
    persist: false,
    duration: const Duration(seconds: 8),
    action: onViewRequests == null
        ? null
        : SnackBarAction(label: 'View requests', onPressed: onViewRequests),
  );
}
