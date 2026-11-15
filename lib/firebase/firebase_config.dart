import 'package:firebase_core/firebase_core.dart' show FirebaseOptions;
import 'package:flutter/foundation.dart' show defaultTargetPlatform, TargetPlatform;

/// The Firebase configuration of the StayServe app.
///
/// The project (`myfirstapp-fa30f52b`) has one Android app and one iOS app.
/// Each platform has its own app id and its own API key, so the options are
/// picked per platform — using the Android app id on iOS makes
/// `Firebase.initializeApp` fail with "no app is associated with this
/// bundle identifier".
///
/// The iOS configuration additionally lives in
/// `ios/Runner/GoogleService-Info.plist`, which the Firebase SDK reads for
/// the things that are not covered by [FirebaseOptions] (the APNs token and
/// the background message handlers).
///
/// The web build has no Firebase app yet, so it uses the Android options —
/// which do not work for the browser. Register a web app in the Firebase
/// console and add its options here before publishing the website.
class DefaultFirebaseOptions {
  const DefaultFirebaseOptions._();

  static FirebaseOptions get currentPlatform {
    if (defaultTargetPlatform == TargetPlatform.iOS) {
      return ios;
    }
    return android;
  }

  static const FirebaseOptions android = FirebaseOptions(
    apiKey: 'AIzaSyDXm8VBnXgwKHajc-0GRwVHb5mk95agIUM',
    appId: '1:96035616668:android:cfc3cf3dab21aa9488fa59',
    messagingSenderId: '96035616668',
    projectId: 'myfirstapp-fa30f52b',
    storageBucket: 'myfirstapp-fa30f52b.firebasestorage.app',
  );

  static const FirebaseOptions ios = FirebaseOptions(
    apiKey: 'AIzaSyD0T834EU7hL2bvpLiIbMc2SFUOyLKz1OL',
    appId: '1:96035616668:ios:e77e14184c868cd688fa59',
    messagingSenderId: '96035616668',
    projectId: 'myfirstapp-fa30f52b',
    storageBucket: 'myfirstapp-fa30f52b.firebasestorage.app',
    iosBundleId: 'com.stayserve.stayserve',
  );
}
