import 'package:flutter_test/flutter_test.dart';
import 'package:stayserve/firebase/owner/room_image_reconciliation.dart';

void main() {
  group('room image reconciliation', () {
    test('preserves a photo added after the form was opened', () {
      final result = reconcileRoomImages(
        currentImages: ['a.jpg', 'b.jpg'],
        originalImages: ['a.jpg'],
        draftImages: ['a.jpg'],
        uploadedImages: const [],
      );

      expect(result.images, ['a.jpg', 'b.jpg']);
      expect(result.removed, isEmpty);
    });

    test('does not restore a photo which another edit already removed', () {
      final result = reconcileRoomImages(
        currentImages: const [],
        originalImages: ['a.jpg'],
        draftImages: ['a.jpg'],
        uploadedImages: const [],
      );

      expect(result.images, isEmpty);
      expect(result.removed, isEmpty);
    });

    test('removes only the photos explicitly removed by the owner', () {
      final result = reconcileRoomImages(
        currentImages: ['a.jpg', 'b.jpg', 'concurrent.jpg'],
        originalImages: ['a.jpg', 'b.jpg'],
        draftImages: ['b.jpg'],
        uploadedImages: const [],
      );

      expect(result.images, ['b.jpg', 'concurrent.jpg']);
      expect(result.removed, ['a.jpg']);
    });

    test('adds the new uploads without duplicates', () {
      final result = reconcileRoomImages(
        currentImages: ['a.jpg'],
        originalImages: ['a.jpg'],
        draftImages: ['a.jpg'],
        uploadedImages: ['new.jpg', 'a.jpg'],
      );

      expect(result.images, ['a.jpg', 'new.jpg']);
      expect(result.removed, isEmpty);
    });

    test('ignores empty and malformed URLs', () {
      final result = reconcileRoomImages(
        currentImages: const ['', 'a.jpg'],
        originalImages: const ['', 'a.jpg'],
        draftImages: const ['a.jpg'],
        uploadedImages: const ['', 'new.jpg'],
      );

      expect(result.images, ['a.jpg', 'new.jpg']);
      expect(result.removed, isEmpty);
    });
  });
}
