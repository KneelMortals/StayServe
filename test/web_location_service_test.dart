@TestOn('browser')
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:stayserve/services/location_service.dart';

void main() {
  test('the browser location service starts without a native geocoder', () {
    expect(LocationService.new, returnsNormally);

    final service = LocationService();
    expect(service.supportsReverseGeocoding, isFalse);
    expect(service.supportsSystemSettings, isFalse);
  });
}
