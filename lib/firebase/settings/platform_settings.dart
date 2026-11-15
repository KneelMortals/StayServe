import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/constants/app_constants.dart';
import '../auth/auth_service.dart';

/// The platform-wide settings that the admin can change from the app.
class PlatformSettings {
  /// Percentage of the monthly rent charged as the platform fee.
  final double feePercentage;

  const PlatformSettings({required this.feePercentage});

  /// The fallback used when the `settings/platform` document does not exist
  /// (yet). It matches the default of the `PLATFORM_FEE_PERCENTAGE`
  /// environment variable of the payment cloud function.
  static const PlatformSettings fallback = PlatformSettings(
    feePercentage: AppConstants.platformFeePercentage,
  );

  factory PlatformSettings.fromJson(Map<String, dynamic> json) {
    final value = json['commissionPercentage'];
    final percentage = value is num ? value.toDouble() : fallback.feePercentage;
    return PlatformSettings(
      // A fee of **0 %** is valid — the platform may waive the fee. The old
      // check treated `0` as invalid and silently fell back to 30 %, so an
      // admin who set the fee to zero was still charging 30 %.
      feePercentage: (percentage >= 0 && percentage <= 100)
          ? percentage
          : fallback.feePercentage,
    );
  }
}

final platformSettingsProvider = FutureProvider<PlatformSettings>((ref) async {
  try {
    final snapshot =
        await ref.watch(firestoreProvider).collection('settings').doc('platform').get();
    if (!snapshot.exists) return PlatformSettings.fallback;
    return PlatformSettings.fromJson(snapshot.data() ?? const {});
  } catch (e) {
    // The settings collection is only readable by signed-in users, so an
    // anonymous visitor simply gets the defaults.
    return PlatformSettings.fallback;
  }
});

/// Reads the platform settings straight from Firestore.
///
/// Used by the repositories, which cannot depend on a provider.
Future<PlatformSettings> loadPlatformSettings(FirebaseFirestore firestore) async {
  try {
    final snapshot = await firestore.collection('settings').doc('platform').get();
    if (!snapshot.exists) return PlatformSettings.fallback;
    return PlatformSettings.fromJson(snapshot.data() ?? const {});
  } catch (e) {
    return PlatformSettings.fallback;
  }
}
