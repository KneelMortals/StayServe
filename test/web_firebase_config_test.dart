import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:stayserve/firebase/firebase_config.dart';

void main() {
  test('the registered Web Firebase app is configured', () {
    expect(
      DefaultFirebaseOptions.web.appId,
      '1:96035616668:web:21b41ac4b3224e4d88fa59',
    );
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

  test('a browser selects the Web Firebase options', () {
    if (kIsWeb) {
      expect(
        DefaultFirebaseOptions.currentPlatform.appId,
        DefaultFirebaseOptions.web.appId,
      );
    }
  });
}
