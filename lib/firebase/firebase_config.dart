import 'package:firebase_core/firebase_core.dart' show FirebaseOptions;
import 'package:flutter/foundation.dart'
    show defaultTargetPlatform, kIsWeb, TargetPlatform;

/// The Firebase configuration of the StayServe app.
///
/// The project (`myfirstapp-fa30f52b`) has one Android app, one iOS app and
/// one web app. Each platform has its own app id and API key, so the options
/// are picked per platform. Reusing one platform's app id on another platform
/// can make `Firebase.initializeApp` fail or leave browser authentication
/// unusable.
///
/// The iOS configuration additionally lives in
/// `ios/Runner/GoogleService-Info.plist`, which the Firebase SDK reads for
/// the things that are not covered by [FirebaseOptions] (the APNs token and
/// the background message handlers).
class DefaultFirebaseOptions {
  const DefaultFirebaseOptions._();

  static FirebaseOptions get currentPlatform {
    if (kIsWeb) {
      return web;
    }
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

  static const FirebaseOptions web = FirebaseOptions(
    apiKey: 'AIzaSyDB_GhneMC3DcwRj52WAhTirNZvvy0yl7M',
    appId: '1:96035616668:web:21b41ac4b3224e4d88fa59',
    authDomain: 'myfirstapp-fa30f52b.firebaseapp.com',
    messagingSenderId: '96035616668',
    projectId: 'myfirstapp-fa30f52b',
    storageBucket: 'myfirstapp-fa30f52b.firebasestorage.app',
    measurementId: 'G-SZ9WG9LBL5',
  );
}
