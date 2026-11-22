import 'package:material_ui/material_ui.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../../core/index.dart';
import '../../../../firebase/visits/visit_repository.dart';

/// Opens the sheet that shows where a room is.
///
/// The address comes from the **server** — it is only handed out when the
/// owner has accepted the booking request of the student.
Future<void> showRoomVisitSheet(BuildContext context, String roomId) async {
  final messenger = ScaffoldMessenger.of(context);
  // The colours are read **before** the await — the context may not be
  // mounted any more when the server answers.
  final errorColor = Theme.of(context).colorScheme.error;

  // The repository is read from the container of the context — the sheet is
  // opened from a plain function, so there is no `WidgetRef` at hand.
  final repository = ProviderScope.containerOf(
    context,
  ).read<VisitRepository>(visitRepositoryProvider);

  // The details are fetched **before** the sheet is opened: the sheet shows
  // the address right away, and a failure is reported in a snack bar.
  RoomVisitDetails details;
  try {
    details = await repository.getVisitDetails(roomId);
  } catch (e) {
    messenger.showSnackBar(
      SnackBar(
        content: Text(e.toString().replaceFirst('Exception: ', '')),
        backgroundColor: errorColor,
      ),
    );
    return;
  }

  if (!context.mounted) return;

  await showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (sheetContext) => _RoomVisitSheet(details: details),
  );
}

/// The sheet with the address of the room.
class _RoomVisitSheet extends StatelessWidget {
  final RoomVisitDetails details;

  const _RoomVisitSheet({required this.details});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(
          AppSpacing.md,
          0,
          AppSpacing.md,
          AppSpacing.md,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Where the room is', style: theme.textTheme.titleLarge),
            const SizedBox(height: AppSpacing.xs),
            Text(details.title, style: theme.textTheme.bodyMedium),
            const SizedBox(height: AppSpacing.md),
            AppCard(
              margin: EdgeInsets.zero,
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(Icons.location_on, color: theme.colorScheme.primary),
                  const SizedBox(width: AppSpacing.md),
                  Expanded(
                    child: Text(
                      details.fullAddress.isEmpty
                          ? 'The owner did not publish an address for this room.'
                          : details.fullAddress,
                      style: theme.textTheme.bodyMedium,
                    ),
                  ),
                ],
              ),
            ),
            if (details.ownerName.trim().isNotEmpty) ...[
              const SizedBox(height: AppSpacing.md),
              Row(
                children: [
                  AppAvatar(name: details.ownerName, radius: 16),
                  const SizedBox(width: AppSpacing.sm),
                  Expanded(
                    child: Text(
                      'Contact: ${details.ownerName}',
                      style: theme.textTheme.bodyMedium,
                    ),
                  ),
                ],
              ),
            ],
            const SizedBox(height: AppSpacing.lg),
            if (details.hasCoordinates) ...[
              AppButton(
                label: 'Open in Google Maps',
                icon: const Icon(Icons.map_outlined),
                onPressed: () => _openGoogleMaps(context),
                isFullWidth: true,
              ),
              const SizedBox(height: AppSpacing.sm),
              AppButton(
                label: 'Open in the maps app',
                icon: const Icon(Icons.navigation_outlined),
                onPressed: () => _openMapsApp(context),
                isFullWidth: true,
                type: ButtonType.secondary,
              ),
              const SizedBox(height: AppSpacing.sm),
            ],
            if (details.fullAddress.isNotEmpty)
              AppButton(
                label: 'Copy the address',
                icon: const Icon(Icons.copy_outlined),
                onPressed: () => _copyAddress(context),
                isFullWidth: true,
                type: ButtonType.secondary,
              ),
          ],
        ),
      ),
    );
  }

  /// The address in the search of Google Maps.
  Future<void> _openGoogleMaps(BuildContext context) async {
    final query = details.hasCoordinates
        ? '${details.latitude},${details.longitude}'
        : details.fullAddress;
    final uri = Uri.parse(
      'https://www.google.com/maps/search/?api=1&query=${Uri.encodeComponent(query)}',
    );

    final messenger = ScaffoldMessenger.of(context);
    try {
      final opened = await launchUrl(uri, mode: LaunchMode.externalApplication);
      if (!opened) {
        messenger.showSnackBar(
          const SnackBar(content: Text('Could not open Google Maps')),
        );
      }
    } catch (e) {
      messenger.showSnackBar(
        SnackBar(content: Text('Could not open Google Maps: $e')),
      );
    }
  }

  /// The address in the maps app of the phone (`geo:`).
  Future<void> _openMapsApp(BuildContext context) async {
    final messenger = ScaffoldMessenger.of(context);

    if (!details.hasCoordinates) {
      messenger.showSnackBar(
        const SnackBar(
          content: Text('This room has no coordinates on the map'),
        ),
      );
      return;
    }

    final label = details.fullAddress.isEmpty
        ? details.title
        : details.fullAddress;
    final uri = Uri.parse(
      'geo:${details.latitude},${details.longitude}'
      '?q=${details.latitude},${details.longitude}(${Uri.encodeComponent(label)})',
    );

    try {
      final opened = await launchUrl(uri, mode: LaunchMode.externalApplication);
      if (!opened) {
        messenger.showSnackBar(
          const SnackBar(content: Text('No maps app found on this device')),
        );
      }
    } catch (e) {
      messenger.showSnackBar(
        SnackBar(content: Text('Could not open the maps app: $e')),
      );
    }
  }

  Future<void> _copyAddress(BuildContext context) async {
    final messenger = ScaffoldMessenger.of(context);
    await Clipboard.setData(ClipboardData(text: details.fullAddress));
    messenger.showSnackBar(
      const SnackBar(content: Text('The address was copied')),
    );
  }
}
