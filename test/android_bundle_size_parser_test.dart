import 'package:flutter_test/flutter_test.dart';

import '../tools/check_android_bundle_size.dart';

void main() {
  group('Bundletool size CSV parser', () {
    test('parses CRLF output from Bundletool 1.18.3', () {
      expect(
        parseBundletoolMaxBytes('MIN,MAX\r\n11920561,13208879\r\n'),
        13208879,
      );
    });

    test('returns the largest MAX when dimensions produce multiple rows', () {
      expect(parseBundletoolMaxBytes('MIN,MAX\r\n1,10\r\n11,25\r\n'), 25);
    });

    test('rejects empty output', () {
      expect(() => parseBundletoolMaxBytes(''), throwsA(isA<ArgumentError>()));
    });

    test('rejects a malformed header', () {
      expect(
        () => parseBundletoolMaxBytes('MINIMUM,MAXIMUM\r\n1,2\r\n'),
        throwsA(isA<FormatException>()),
      );
    });

    test('rejects output without a size row', () {
      expect(
        () => parseBundletoolMaxBytes('MIN,MAX\r\n'),
        throwsA(isA<FormatException>()),
      );
    });

    test('rejects a malformed size row', () {
      expect(
        () => parseBundletoolMaxBytes('MIN,MAX\r\n1,2,3\r\n'),
        throwsA(isA<FormatException>()),
      );
    });

    test('rejects non-numeric sizes', () {
      expect(
        () => parseBundletoolMaxBytes('MIN,MAX\r\n1,not-a-size\r\n'),
        throwsA(isA<FormatException>()),
      );
    });

    test('rejects a row whose MIN exceeds MAX', () {
      expect(
        () => parseBundletoolMaxBytes('MIN,MAX\r\n10,9\r\n'),
        throwsA(isA<FormatException>()),
      );
    });
  });

  group('Bundletool size limit', () {
    test('accepts a maximum strictly below the limit', () {
      expect(
        () => validateBundletoolSize(
          'MIN,MAX\r\n1,39999999\r\n',
          limitBytes: 40000000,
        ),
        returnsNormally,
      );
    });

    test('rejects a maximum equal to the limit', () {
      expect(
        () => validateBundletoolSize(
          'MIN,MAX\r\n1,40000000\r\n',
          limitBytes: 40000000,
        ),
        throwsA(isA<ArgumentError>()),
      );
    });

    test('rejects a maximum above the limit', () {
      expect(
        () => validateBundletoolSize(
          'MIN,MAX\r\n1,40000001\r\n',
          limitBytes: 40000000,
        ),
        throwsA(isA<ArgumentError>()),
      );
    });
  });
}
