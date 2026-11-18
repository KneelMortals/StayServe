import 'package:flutter_test/flutter_test.dart';
import 'package:stayserve/firebase/student/student_repository.dart';

void main() {
  group('saved-room profile parsing', () {
    test('keeps valid room ids and ignores malformed entries', () {
      final roomIds = savedRoomIdsFromProfile([
        'room-1',
        7,
        null,
        {'roomId': 'room-2'},
        '',
        '   ',
        'room-1',
        'room-3',
      ]);

      expect(roomIds, ['room-1', 'room-3']);
    });

    test('returns an empty list when the field has the wrong shape', () {
      expect(savedRoomIdsFromProfile(null), isEmpty);
      expect(savedRoomIdsFromProfile('room-1'), isEmpty);
      expect(savedRoomIdsFromProfile({'room-1': true}), isEmpty);
    });

    test('preserves the exact stored id used by Firestore arrayRemove', () {
      expect(savedRoomIdsFromProfile([' room-1 ']), [' room-1 ']);
    });
  });
}
