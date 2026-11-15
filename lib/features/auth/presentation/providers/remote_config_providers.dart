import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:package_info_plus/package_info_plus.dart';

import '../../../../firebase/remote_config/remote_config_service.dart';

final remoteConfigProvider = FutureProvider<RemoteConfigService>((ref) async {
  final service = ref.watch(remoteConfigServiceProvider);
  await service.initialize();
  return service;
});

final appVersionProvider = FutureProvider<String>((ref) async {
  final packageInfo = await PackageInfo.fromPlatform();
  return packageInfo.version;
});

final forceUpdateCheckProvider = FutureProvider<ForceUpdateResult>((ref) async {
  final remoteConfig = await ref.watch(remoteConfigProvider.future);
  final currentVersion = await ref.watch(appVersionProvider.future);

  return ForceUpdateResult(
    isUpdateRequired: remoteConfig.isUpdateRequired(currentVersion),
    isForceUpdate: remoteConfig.isForceUpdate(currentVersion),
    currentVersion: currentVersion,
    latestVersion: remoteConfig.getLatestVersion(),
    minVersion: remoteConfig.getMinAppVersion(),
    message: remoteConfig.getUpdateMessage(),
    updateUrlAndroid: remoteConfig.getUpdateUrlAndroid(),
    updateUrlIos: remoteConfig.getUpdateUrlIos(),
    maintenanceMode: remoteConfig.getMaintenanceMode(),
    maintenanceMessage: remoteConfig.getMaintenanceMessage(),
  );
});

class ForceUpdateResult {
  final bool isUpdateRequired;
  final bool isForceUpdate;
  final String currentVersion;
  final String latestVersion;
  final String minVersion;
  final String message;
  final String updateUrlAndroid;
  final String updateUrlIos;
  final bool maintenanceMode;
  final String maintenanceMessage;

  ForceUpdateResult({
    required this.isUpdateRequired,
    required this.isForceUpdate,
    required this.currentVersion,
    required this.latestVersion,
    required this.minVersion,
    required this.message,
    required this.updateUrlAndroid,
    required this.updateUrlIos,
    required this.maintenanceMode,
    required this.maintenanceMessage,
  });

  factory ForceUpdateResult.fromJson(Map<String, dynamic> json) {
    return ForceUpdateResult(
      isUpdateRequired: json['isUpdateRequired'] as bool,
      isForceUpdate: json['isForceUpdate'] as bool,
      currentVersion: json['currentVersion'] as String,
      latestVersion: json['latestVersion'] as String,
      minVersion: json['minVersion'] as String,
      message: json['message'] as String,
      updateUrlAndroid: json['updateUrlAndroid'] as String,
      updateUrlIos: json['updateUrlIos'] as String,
      maintenanceMode: json['maintenanceMode'] as bool,
      maintenanceMessage: json['maintenanceMessage'] as String,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'isUpdateRequired': isUpdateRequired,
      'isForceUpdate': isForceUpdate,
      'currentVersion': currentVersion,
      'latestVersion': latestVersion,
      'minVersion': minVersion,
      'message': message,
      'updateUrlAndroid': updateUrlAndroid,
      'updateUrlIos': updateUrlIos,
      'maintenanceMode': maintenanceMode,
      'maintenanceMessage': maintenanceMessage,
    };
  }
}