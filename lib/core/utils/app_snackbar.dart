import 'package:flutter/material.dart';

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

  /// Shows the error of a failed action, if there is one.
  ///
  /// Returns `true` when an error was shown.
  bool showErrorIfAny(String? error) {
    if (error == null || error.trim().isEmpty) return false;
    showErrorSnackBar(error);
    return true;
  }
}
