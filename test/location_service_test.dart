import 'package:flutter_test/flutter_test.dart';
import 'package:stayserve/services/location_service.dart';

void main() {
  test('the location service starts without a native geocoder', () {
    expect(LocationService.new, returnsNormally);
  });

  test('the web build does not construct the native geocoder', () {
    var factoryCalled = false;

    final service = LocationService.forTesting(
      isWeb: true,
      geocodingFactory: () {
        factoryCalled = true;
        throw StateError('The native geocoder must not be used on web');
      },
    );

    expect(factoryCalled, isFalse);
    expect(service.supportsReverseGeocoding, isFalse);
    expect(service.supportsSystemSettings, isFalse);
  });

  test('a missing native geocoder is handled as an unavailable capability', () {
    final service = LocationService.forTesting(
      isWeb: false,
      geocodingFactory: () {
        throw StateError('No geocoder is registered in this test');
      },
    );

    expect(service.supportsReverseGeocoding, isFalse);
    expect(service.supportsSystemSettings, isTrue);
  });

  test('web reverse-geocoding calls fail safely without a geocoder', () async {
    final service = LocationService.forTesting(isWeb: true);

    expect(await service.reverseGeocode(12.9716, 77.5946), isNull);
    expect(await service.resolvePincodeLocation('560001'), isNull);
  });
}
