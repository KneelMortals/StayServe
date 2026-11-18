import 'dart:convert';
import 'dart:io';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:stayserve/core/constants/enums.dart';
import 'package:stayserve/firebase/student/student_repository.dart';
import 'package:stayserve/models/room_model.dart';

RoomModel _room({
  required String id,
  required double rent,
  required DateTime createdAt,
  double? latitude,
  double? longitude,
}) {
  return RoomModel(
    roomId: id,
    ownerId: 'owner-1',
    title: 'Room $id',
    description: 'Description',
    monthlyRent: rent,
    securityDeposit: 0,
    location: const Location(city: 'Bengaluru', state: 'Karnataka'),
    roomType: RoomType.single,
    furnishing: FurnishingType.unfurnished,
    availableFrom: createdAt,
    occupancy: 2,
    genderPreference: GenderPreference.any,
    status: RoomStatus.available,
    createdAt: createdAt,
    updatedAt: createdAt,
    latitude: latitude,
    longitude: longitude,
  );
}

void main() {
  group('room-search pagination', () {
    test('a relevance cursor contains the ordered query values', () {
      final createdAt = DateTime.utc(2026, 1, 2, 3, 4, 5);
      final cursor = RoomSearchCursor(
        sort: 'relevance',
        monthlyRent: null,
        createdAt: createdAt,
        documentId: 'room-2',
      );

      expect(cursor.values, [Timestamp.fromDate(createdAt), 'room-2']);
    });

    test('a rent cursor contains the rent-ordered query values', () {
      final createdAt = DateTime.utc(2026, 1, 2, 3, 4, 5);
      final cursor = RoomSearchCursor(
        sort: 'lowest_rent',
        monthlyRent: 7500,
        createdAt: createdAt,
        documentId: 'room-2',
      );

      expect(cursor.values, [7500.0, Timestamp.fromDate(createdAt), 'room-2']);
    });

    test('a malformed numeric createdAt still advances the raw cursor', () {
      final cursor = RoomSearchCursor.fromDocumentData(
        {'createdAt': 123},
        'room-malformed',
        'relevance',
      );

      expect(cursor, isNotNull);
      expect(cursor!.values, [123, 'room-malformed']);
    });

    test('a malformed rent value remains the exact Firestore order value', () {
      final cursor = RoomSearchCursor.fromDocumentData(
        {
          'createdAt': Timestamp.fromDate(DateTime.utc(2026)),
          'monthlyRent': 7500,
        },
        'room-malformed-rent',
        'lowest_rent',
      );

      expect(cursor, isNotNull);
      expect(cursor!.values[0], 7500);
    });

    test('a non-orderable cursor value fails closed', () {
      final cursor = RoomSearchCursor.fromDocumentData(
        {
          'createdAt': {'not': 'orderable'},
        },
        'room-malformed',
        'relevance',
      );

      expect(cursor, isNull);
    });

    test('deployment indexes cover every paginated room ordering', () {
      final decoded =
          jsonDecode(File('firestore.indexes.json').readAsStringSync())
              as Map<String, dynamic>;
      final indexes = (decoded['indexes'] as List<dynamic>)
          .cast<Map<String, dynamic>>();

      bool hasRoomIndex(List<String> expectedFields) {
        return indexes.any((index) {
          if (index['collectionGroup'] != 'rooms') return false;
          final fields = (index['fields'] as List<dynamic>)
              .cast<Map<String, dynamic>>();
          final actual = fields
              .map((field) => '${field['fieldPath']} ${field['order']}')
              .toList();
          return actual.join('|') == expectedFields.join('|');
        });
      }

      expect(
        hasRoomIndex(['createdAt DESCENDING', '__name__ ASCENDING']),
        isTrue,
      );
      expect(
        hasRoomIndex([
          'monthlyRent ASCENDING',
          'createdAt DESCENDING',
          '__name__ ASCENDING',
        ]),
        isTrue,
      );
      expect(
        hasRoomIndex([
          'monthlyRent DESCENDING',
          'createdAt DESCENDING',
          '__name__ ASCENDING',
        ]),
        isTrue,
      );
    });

    test('deployment indexes avoid redundant document-id composites', () {
      final decoded =
          jsonDecode(File('firestore.indexes.json').readAsStringSync())
              as Map<String, dynamic>;
      final indexes = (decoded['indexes'] as List<dynamic>)
          .cast<Map<String, dynamic>>();

      bool hasIndex(String collection, List<String> expectedFields) {
        return indexes.any((index) {
          if (index['collectionGroup'] != collection) return false;
          final fields = (index['fields'] as List<dynamic>)
              .cast<Map<String, dynamic>>();
          final actual = fields.map((field) {
            final arrayConfig = field['arrayConfig'];
            if (arrayConfig != null) {
              return '${field['fieldPath']} $arrayConfig';
            }
            return '${field['fieldPath']} ${field['order']}';
          }).toList();
          return actual.join('|') == expectedFields.join('|');
        });
      }

      // An equality filter followed by orderBy(__name__) is served by
      // Firestore's automatic single-field indexes. The production index API
      // rejects an explicit two-field composite for that shape as
      // "not necessary", so declaring one would make the entire index
      // deployment fail.
      const redundantDocumentIdIndexes = <MapEntry<String, List<String>>>[
        MapEntry('rooms', ['ownerId ASCENDING', '__name__ ASCENDING']),
        MapEntry('joinRequests', ['studentId ASCENDING', '__name__ ASCENDING']),
        MapEntry('payments', ['studentId ASCENDING', '__name__ ASCENDING']),
        MapEntry('roomPrivate', ['ownerId ASCENDING', '__name__ ASCENDING']),
        MapEntry('commissionInvoices', [
          'ownerId ASCENDING',
          '__name__ ASCENDING',
        ]),
        MapEntry('notifications', ['userId ASCENDING', '__name__ ASCENDING']),
        MapEntry('roomReviews', ['roomId ASCENDING', '__name__ ASCENDING']),
        MapEntry('otpCodes', ['verifiedByUid ASCENDING', '__name__ ASCENDING']),
        MapEntry('conversations', [
          'participantIds CONTAINS',
          '__name__ ASCENDING',
        ]),
        MapEntry('cleanupJobs', ['type ASCENDING', '__name__ ASCENDING']),
        MapEntry('accountDeletionJobs', [
          'status ASCENDING',
          '__name__ ASCENDING',
        ]),
        MapEntry('users', [
          'deletionScheduled ASCENDING',
          '__name__ ASCENDING',
        ]),
        MapEntry('joinRequests', ['ownerId ASCENDING', '__name__ ASCENDING']),
        MapEntry('joinRequests', ['roomId ASCENDING', '__name__ ASCENDING']),
        MapEntry('roomReviews', ['studentId ASCENDING', '__name__ ASCENDING']),
        MapEntry('roomReviews', ['ownerId ASCENDING', '__name__ ASCENDING']),
        MapEntry('payments', ['ownerId ASCENDING', '__name__ ASCENDING']),
        MapEntry('commissionInvoices', [
          'tenantId ASCENDING',
          '__name__ ASCENDING',
        ]),
        MapEntry('cleanupJobs', ['ownerId ASCENDING', '__name__ ASCENDING']),
        MapEntry('roomDeletionTombstones', [
          'ownerId ASCENDING',
          '__name__ ASCENDING',
        ]),
      ];

      for (final entry in redundantDocumentIdIndexes) {
        expect(
          hasIndex(entry.key, entry.value),
          isFalse,
          reason:
              '${entry.key} must rely on Firestore single-field indexes; '
              'the redundant composite is rejected by the deployment API',
        );
      }

      // Two equality filters plus the document id do need a composite index.
      // Its explicit ascending document-id order is accepted by Firestore.
      expect(
        hasIndex('roleClaimJobs', [
          'type ASCENDING',
          'status ASCENDING',
          '__name__ ASCENDING',
        ]),
        isTrue,
      );
    });

    test('appended pages are re-sorted as one result set', () {
      final older = _room(
        id: 'older',
        rent: 9000,
        createdAt: DateTime.utc(2026, 1, 1),
      );
      final newer = _room(
        id: 'newer',
        rent: 5000,
        createdAt: DateTime.utc(2026, 1, 2),
      );

      final sorted = StudentRepository.sortRooms([older, newer], 'lowest_rent');

      expect(sorted.map((room) => room.roomId), ['newer', 'older']);
    });
  });
}
