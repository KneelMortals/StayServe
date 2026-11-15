import 'dart:io' as io;

import 'package:flutter/services.dart' show SystemNavigator;

/// Closes the application.
///
/// This is the implementation for the platforms that have a process to end
/// (Android, iOS, Linux, macOS, Windows). The web build gets the stub from
/// `app_exit_stub.dart` — a browser tab cannot close itself.
Future<void> quitApp() async {
  // `SystemNavigator.pop()` asks the platform to close the current
  // activity. On Android that finishes the app, but it does **not** stop
  // the process: the app can still be resumed from the recents list, which
  // is what made the "Exit" button of the launch-area dialog look broken.
  try {
    await SystemNavigator.pop();
  } catch (_) {
    // Some platforms do not implement it — `exit(0)` below still ends the
    // app.
  }

  // Give the platform a moment to finish the activity, then end the
  // process for good.
  await Future<void>.delayed(const Duration(milliseconds: 150));

  io.exit(0);
}
