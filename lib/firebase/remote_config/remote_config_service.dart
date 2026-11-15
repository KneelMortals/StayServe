import 'package:firebase_remote_config/firebase_remote_config.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/utils/app_logger.dart';

final remoteConfigServiceProvider = Provider<RemoteConfigService>((ref) {
  return RemoteConfigService();
});

class RemoteConfigService {
  final FirebaseRemoteConfig _remoteConfig = FirebaseRemoteConfig.instance;

  Future<void> initialize() async {
    await _remoteConfig.setConfigSettings(RemoteConfigSettings(
      minimumFetchInterval: const Duration(hours: 1),
      fetchTimeout: const Duration(seconds: 10),
    ));

    await _remoteConfig.setDefaults({
      'min_app_version': '1.0.0',
      'latest_version': '1.0.0',
      'force_update': false,
      'update_message': 'A new version is available. Please update to continue.',
      'update_url_android': '',
      'update_url_ios': '',
      'maintenance_mode': false,
      'maintenance_message': 'App is under maintenance. Please try again later.',
    });

    await fetchAndActivate();
  }

  Future<bool> fetchAndActivate() async {
    try {
      final fetched = await _remoteConfig.fetchAndActivate();
      return fetched;
    } catch (e) {
      AppLogger.warning('Remote Config fetch failed', error: e);
      return false;
    }
  }

  String getMinAppVersion() => _remoteConfig.getString('min_app_version');
  String getLatestVersion() => _remoteConfig.getString('latest_version');
  bool getForceUpdate() => _remoteConfig.getBool('force_update');
  String getUpdateMessage() => _remoteConfig.getString('update_message');
  String getUpdateUrlAndroid() => _remoteConfig.getString('update_url_android');
  String getUpdateUrlIos() => _remoteConfig.getString('update_url_ios');
  bool getMaintenanceMode() => _remoteConfig.getBool('maintenance_mode');
  String getMaintenanceMessage() => _remoteConfig.getString('maintenance_message');

  // Version comparison helper
  int compareVersions(String current, String required) {
    final currentParts = current.split('.').map(int.parse).toList();
    final requiredParts = required.split('.').map(int.parse).toList();

    for (int i = 0; i < 3; i++) {
      final c = i < currentParts.length ? currentParts[i] : 0;
      final r = i < requiredParts.length ? requiredParts[i] : 0;
      if (c < r) return -1;
      if (c > r) return 1;
    }
    return 0;
  }

  bool isUpdateRequired(String currentVersion) {
    final minVersion = getMinAppVersion();
    return compareVersions(currentVersion, minVersion) < 0;
  }

  bool isForceUpdate(String currentVersion) {
    return getForceUpdate() && isUpdateRequired(currentVersion);
  }
}