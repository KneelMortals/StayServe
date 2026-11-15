/// Closes the application.
///
/// The implementation is picked per platform: `app_exit_native.dart` ends
/// the process on Android / iOS / desktop, `app_exit_stub.dart` does nothing
/// on the web (a browser tab may not close itself).
library;

export 'app_exit_stub.dart' if (dart.library.io) 'app_exit_native.dart';
