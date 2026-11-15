import 'package:flutter_riverpod/flutter_riverpod.dart';

/// The screen a push notification asked for — waiting for the app to be
/// ready for it.
///
/// ## Why this is needed
///
/// When the app is **started** by a tap on a push notification, the splash
/// screen is still running: it checks the remote config, the session and
/// the launch area before it lets anybody in. Two things then want to
/// navigate:
///
///  * the **tap handler** — it opens the screen the notification was
///    about, and
///  * the **splash screen** — it opens the home screen of the role as soon
///    as it is done.
///
/// Whichever of the two navigates **last** wins. The splash screen usually
/// needs the location, so it is often the slower one — and then the user
/// tapped the notification, the app opened … on the home screen. The
/// notification looked like it did nothing at all.
///
/// The route is therefore remembered here until the splash screen picks it
/// up.
final pendingNotificationRouteProvider = StateProvider<String?>((ref) => null);
