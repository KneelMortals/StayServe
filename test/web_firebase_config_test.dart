import 'package:flutter/foundation.dart'
    show defaultTargetPlatform, kIsWeb, TargetPlatform;
import 'package:flutter_test/flutter_test.dart';
import 'package:stayserve/firebase/firebase_config.dart';

void main() {
  test('the registered Firebase apps are configured', () {
    expect(
      DefaultFirebaseOptions.android.appId,
      '1:96035616668:android:cfc3cf3dab21aa9488fa59',
    );
    expect(
      DefaultFirebaseOptions.ios.appId,
      '1:96035616668:ios:e77e14184c868cd688fa59',
    );
    expect(
      DefaultFirebaseOptions.ios.apiKey,
      'AIzaSyD0T834EW7hL_kbvpLitImc2SF5OyKNzOQ',
    );
    expect(
      DefaultFirebaseOptions.web.appId,
      '1:96035616668:web:21b41ac4b3224e4d88fa59',
    );
    expect(
      DefaultFirebaseOptions.web.apiKey,
      'AIzaSyDB_GhneMC3DcwRj52WAhTirNZvvy0yl7M',
    );
    expect(DefaultFirebaseOptions.web.messagingSenderId, '96035616668');
    expect(DefaultFirebaseOptions.web.projectId, 'myfirstapp-fa30f52b');
    expect(
      DefaultFirebaseOptions.web.authDomain,
      'myfirstapp-fa30f52b.firebaseapp.com',
    );
    expect(
      DefaultFirebaseOptions.web.storageBucket,
      'myfirstapp-fa30f52b.firebasestorage.app',
    );
  });

  test('platform selection returns the registered Firebase options', () {
    expect(
      DefaultFirebaseOptions.optionsForPlatform(
        isWeb: true,
        platform: TargetPlatform.android,
      ).appId,
      DefaultFirebaseOptions.web.appId,
    );
    expect(
      DefaultFirebaseOptions.optionsForPlatform(
        isWeb: false,
        platform: TargetPlatform.iOS,
      ).appId,
      DefaultFirebaseOptions.ios.appId,
    );

    if (kIsWeb) {
      expect(
        DefaultFirebaseOptions.currentPlatform.appId,
        DefaultFirebaseOptions.web.appId,
      );
    } else if (defaultTargetPlatform == TargetPlatform.iOS) {
      expect(
        DefaultFirebaseOptions.currentPlatform.appId,
        DefaultFirebaseOptions.ios.appId,
      );
    } else {
      expect(
        DefaultFirebaseOptions.currentPlatform.appId,
        DefaultFirebaseOptions.android.appId,
      );
    }
  });
}
