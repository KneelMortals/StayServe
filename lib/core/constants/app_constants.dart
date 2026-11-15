class AppConstants {
  static const String appName = 'StayServe';
  static const String appVersion = '1.0.0';

  // ---------------------------------------------------------------------------
  // Payments
  // ---------------------------------------------------------------------------

  /// The UPI virtual payment address that receives **every** payment collected
  /// through the app.
  ///
  /// This is the single source of truth — never hardcode the VPA anywhere
  /// else. The Cloud Function builds the UPI intent with the same value, so
  /// the payee cannot be tampered with by a modified client.
  static const String platformUpiVpa = 'shauryaprataprai461-2@oksbi';

  /// Payee name shown in the UPI app.
  static const String platformUpiName = 'StayServe';

  /// Percentage of the monthly rent charged as the platform fee.
  static const double platformFeePercentage = 30;

  /// The address users can contact for support.
  static const String supportEmail = 'shauryaprataprai2007@gmail.com';

  static const int defaultPageSize = 20;
  static const int maxImageSize = 5 * 1024 * 1024; // 5MB
  static const int imageCompressionQuality = 80;
  static const int maxImagesPerRoom = 10;

  static const Duration debounceDuration = Duration(milliseconds: 300);
  static const Duration animationDuration = Duration(milliseconds: 250);

  static const String firebaseConfigFile = 'firebase_options.dart';

  static const List<String> indianStates = [
    'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh',
    'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka',
    'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram',
    'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu',
    'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
    'Andaman and Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu',
    'Delhi', 'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry',
  ];

  static const List<String> roomTypes = ['single', 'double', 'triple', 'shared'];
  static const List<String> furnishingTypes = ['unfurnished', 'semi', 'fully'];
  static const List<String> genderPreferences = ['male', 'female', 'any'];
  static const List<String> roomStatuses = ['available', 'occupied', 'inactive'];

  static const List<String> amenities = [
    'WiFi', 'AC', 'Geyser', 'Washing Machine', 'Refrigerator', 'TV',
    'Attached Bathroom', 'Balcony', 'Parking', 'Security', 'Power Backup',
    'Lift', 'Furnished', 'Meals', 'Laundry', 'Housekeeping',
  ];

  static const List<String> sortOptions = [
    'relevance', 'distance', 'lowest_rent', 'highest_rent', 'newest',
  ];

  static const Map<String, String> sortLabels = {
    'relevance': 'Relevance',
    'distance': 'Nearest first',
    'lowest_rent': 'Lowest Rent',
    'highest_rent': 'Highest Rent',
    'newest': 'Newest First',
  };

  /// The distance limits the student can pick in the search filters.
  ///
  /// The value is the radius in kilometres; `null` means "no limit".
  static const List<double?> distanceOptions = [
    null, 1, 2, 5, 10, 25, 50,
  ];

  /// The label of a distance filter option.
  static String distanceOptionLabel(double? km) {
    if (km == null) return 'Any distance';
    if (km < 1) return 'Under ${(km * 1000).round()} m';
    return 'Within $km km';
  }
}