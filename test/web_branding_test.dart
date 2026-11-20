import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('the web client uses the StayServe logo for branding', () async {
    final logo = await rootBundle.load('assets/images/logo.png');
    final logoBytes = logo.buffer.asUint8List();
    expect(logoBytes.length, greaterThan(1000));

    final webIcon = await File('web/icons/Icon-512.png').readAsBytes();
    expect(webIcon, orderedEquals(logoBytes));

    final favicon = await File('web/favicon.png').readAsBytes();
    expect(favicon, isNotEmpty);
    expect(
      favicon.take(8),
      orderedEquals(const [137, 80, 78, 71, 13, 10, 26, 10]),
    );

    final index = await File('web/index.html').readAsString();
    expect(index, contains('id="stayserve-loader"'));
    expect(index, contains('src="icons/Icon-192.png"'));
    expect(index, contains('flutter-first-frame'));
    expect(index, contains('MutationObserver'));

    final splash = await File(
      'lib/features/auth/presentation/screens/splash_screen.dart',
    ).readAsString();
    expect(splash, contains("'assets/images/logo.png'"));
  });

  test(
    'the production Storage CORS policy allows the published web client',
    () {
      final policy =
          jsonDecode(File('storage.cors.json').readAsStringSync())
              as List<dynamic>;
      final rule = policy.single as Map<String, dynamic>;
      final origins = (rule['origin'] as List<dynamic>).cast<String>();
      final methods = (rule['method'] as List<dynamic>).cast<String>();

      expect(origins, contains('https://myfirstapp-fa30f52b.web.app'));
      expect(origins, contains('https://myfirstapp-fa30f52b.firebaseapp.com'));
      expect(methods, contains('GET'));
      expect(origins, isNot(contains('*')));
    },
  );
}
