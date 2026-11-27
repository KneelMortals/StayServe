import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:image/image.dart' as img;

import 'package:stayserve/features/profile/presentation/widgets/profile_picture_cropper.dart';

void main() {
  group('the cropped picture', () {
    test('a PNG becomes a JPEG', () async {
      final source = img.Image(width: 32, height: 32);
      img.fill(source, color: img.ColorRgb8(10, 120, 200));
      final png = img.encodePng(source);

      final jpeg = await encodeProfilePicture(Uint8List.fromList(png));

      expect(jpeg.length, greaterThan(0));
      // A JPEG always starts with the marker 0xFF 0xD8 0xFF.
      expect(jpeg.take(3).toList(), [0xff, 0xd8, 0xff]);
    });

    test('a broken picture is refused with a readable message', () async {
      await expectLater(
        encodeProfilePicture(Uint8List.fromList([1, 2, 3, 4])),
        throwsA(
          isA<StateError>().having(
            (error) => error.message,
            'message',
            contains('could not be read'),
          ),
        ),
      );
    });

    test('a big picture is scaled down before it is uploaded', () async {
      final source = img.Image(width: 2400, height: 1200);
      final png = img.encodePng(source);

      final jpeg = await encodeProfilePicture(Uint8List.fromList(png));
      final decoded = img.decodeJpg(jpeg);

      expect(decoded, isNotNull);
      expect(decoded!.width, lessThanOrEqualTo(kProfilePictureMaxEdge));
      expect(decoded.height, lessThanOrEqualTo(kProfilePictureMaxEdge));
    });

    test('a small picture keeps its size', () async {
      final source = img.Image(width: 200, height: 100);
      final png = img.encodePng(source);

      final jpeg = await encodeProfilePicture(Uint8List.fromList(png));
      final decoded = img.decodeJpg(jpeg);

      expect(decoded!.width, 200);
      expect(decoded.height, 100);
    });
  });

  group('the picture formats', () {
    test('a JPEG can be cropped', () {
      expect(
        isCroppablePicture(Uint8List.fromList([0xff, 0xd8, 0xff, 0xe0])),
        isTrue,
      );
    });

    test('a PNG can be cropped', () {
      expect(
        isCroppablePicture(Uint8List.fromList([0x89, 0x50, 0x4e, 0x47, 0x0d])),
        isTrue,
      );
    });

    test('a GIF can be cropped', () {
      expect(
        isCroppablePicture(Uint8List.fromList([0x47, 0x49, 0x46, 0x38])),
        isTrue,
      );
    });

    test('a WebP picture can be cropped', () {
      final bytes = <int>[
        0x52,
        0x49,
        0x46,
        0x46,
        0,
        0,
        0,
        0,
        0x57,
        0x45,
        0x42,
        0x50,
      ];
      expect(isCroppablePicture(Uint8List.fromList(bytes)), isTrue);
    });

    test('a HEIC picture is converted by the platform first', () {
      // The header of a HEIF container: the cropper cannot read it.
      final bytes = <int>[
        0,
        0,
        0,
        0x18,
        0x66,
        0x74,
        0x79,
        0x70,
        0x68,
        0x65,
        0x69,
        0x66,
      ];
      expect(isCroppablePicture(Uint8List.fromList(bytes)), isFalse);
    });

    test('an empty file is not croppable', () {
      expect(isCroppablePicture(Uint8List(0)), isFalse);
    });
  });
}
