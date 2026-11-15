import 'dart:developer' as developer;

import 'package:flutter/foundation.dart';

/// Lightweight application logger.
///
/// Uses `dart:developer`'s `log()` so that the messages show up in the
/// IDE/DevTools, and `debugPrint()` so that they also end up in the Android
/// logcat (`adb logcat | grep StayServe`) and in `flutter logs`.
///
/// `dart:developer` alone is **not** enough: on Android those messages only
/// travel to the attached VM service, so a crash report or a support request
/// that only carries the logcat would not contain a single line of the
/// application's own diagnostics — which makes problems such as "the app let
/// me in even though I am not in a launch area" impossible to track down.
class AppLogger {
  const AppLogger._();

  static const String _defaultName = 'StayServe';

  /// Log an informational message.
  static void info(String message, {String name = _defaultName}) {
    developer.log(message, name: name, level: 800);
    debugPrint('[$name] $message');
  }

  /// Log a recoverable problem that did not stop the operation.
  static void warning(
    String message, {
    Object? error,
    StackTrace? stackTrace,
    String name = _defaultName,
  }) {
    developer.log(
      message,
      name: name,
      error: error,
      stackTrace: stackTrace,
      level: 900,
    );
    debugPrint('[$name] WARNING: $message${_formatError(error)}');
  }

  /// Log an unrecoverable error.
  static void error(
    String message, {
    Object? error,
    StackTrace? stackTrace,
    String name = _defaultName,
  }) {
    developer.log(
      message,
      name: name,
      error: error,
      stackTrace: stackTrace,
      level: 1000,
    );
    debugPrint('[$name] ERROR: $message${_formatError(error)}');
  }

  /// The error and the stack trace, rendered for a single log line.
  static String _formatError(Object? error) {
    if (error == null) return '';
    return ' | $error';
  }
}
