import 'package:material_ui/material_ui.dart';
import 'package:go_router/go_router.dart';

import '../../models/room_model.dart';
import '../constants/enums.dart';
import '../theme/app_theme.dart';
import '../utils/distance.dart';
import '../utils/validators.dart';
import 'common_widgets.dart';

/// Card showing a room listing. Tapping it opens the room detail screen.
class RoomCard extends StatelessWidget {
  final RoomModel room;
  final VoidCallback? onTap;
  final bool showStatus;

  /// The distance of the room from the user, in kilometres.
  ///
  /// When it is `null` the distance is simply not shown — the app does not
  /// know where the user is (yet) or the listing has no coordinates.
  final double? distanceKm;

  const RoomCard({
    required this.room,
    this.onTap,
    this.showStatus = true,
    this.distanceKm,
    super.key,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return AppCard(
      margin: EdgeInsets.zero,
      padding: EdgeInsets.zero,
      onTap: onTap ?? () => context.push('/room/${room.roomId}'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Stack(
            children: [
              AppImage(
                imageUrl: room.primaryImage.isEmpty ? null : room.primaryImage,
                width: double.infinity,
                height: 160,
                borderRadius: const BorderRadius.vertical(
                  top: Radius.circular(AppBorderRadius.lg),
                ),
                placeholder: Container(
                  height: 160,
                  color: theme.colorScheme.surfaceContainerHighest,
                  child: const Center(
                    child: Icon(Icons.bedroom_parent_outlined, size: 40),
                  ),
                ),
              ),
              if (showStatus)
                Positioned(
                  top: AppSpacing.sm,
                  left: AppSpacing.sm,
                  child: _StatusChip(status: room.status),
                ),
              Positioned(
                top: AppSpacing.sm,
                right: AppSpacing.sm,
                child: _RentChip(rent: room.monthlyRent),
              ),
              if (distanceKm != null)
                Positioned(
                  bottom: AppSpacing.sm,
                  left: AppSpacing.sm,
                  child: _DistanceChip(distanceKm: distanceKm!),
                ),
            ],
          ),
          Padding(
            padding: const EdgeInsets.all(AppSpacing.md),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  room.title,
                  style: theme.textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w600,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                const SizedBox(height: AppSpacing.xs),
                Row(
                  children: [
                    Icon(
                      Icons.location_on_outlined,
                      size: 16,
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                    const SizedBox(width: AppSpacing.xs),
                    Expanded(
                      child: Text(
                        room.location.shortAddress,
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    if (distanceKm != null) ...[
                      const SizedBox(width: AppSpacing.sm),
                      Icon(
                        Icons.near_me_outlined,
                        size: 14,
                        color: theme.colorScheme.primary,
                      ),
                      const SizedBox(width: AppSpacing.xs),
                      Text(
                        DistanceUtils.formatDistanceShort(distanceKm),
                        style: theme.textTheme.labelSmall?.copyWith(
                          color: theme.colorScheme.primary,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ],
                  ],
                ),
                const SizedBox(height: AppSpacing.sm),
                Wrap(
                  spacing: AppSpacing.sm,
                  runSpacing: AppSpacing.xs,
                  children: [
                    _Tag(text: room.roomType.label),
                    _Tag(text: room.furnishing.label),
                    _Tag(
                      text: '${room.availableSlots} of ${room.occupancy} free',
                    ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _StatusChip extends StatelessWidget {
  final RoomStatus status;

  const _StatusChip({required this.status});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final color = status == RoomStatus.available
        ? theme.colorScheme.primary
        : theme.colorScheme.error;

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.15),
        borderRadius: BorderRadius.circular(AppBorderRadius.sm),
      ),
      child: Text(
        status.label,
        style: theme.textTheme.labelSmall?.copyWith(
          color: color,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}

class _RentChip extends StatelessWidget {
  final double rent;

  const _RentChip({required this.rent});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm, vertical: 4),
      decoration: BoxDecoration(
        // `surfaceContainerHighest` instead of `surface`: in dark mode a
        // plain surface is almost black, and the rent text (which uses the
        // default on-surface colour) was unreadable on top of it.
        color: theme.colorScheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(AppBorderRadius.sm),
      ),
      child: Text(
        '${AppFormatters.formatCurrency(rent)}/mo',
        style: theme.textTheme.labelMedium?.copyWith(
          color: theme.colorScheme.onSurface,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}

/// The little badge that shows how far away the room is.
class _DistanceChip extends StatelessWidget {
  final double distanceKm;

  const _DistanceChip({required this.distanceKm});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm, vertical: 4),
      decoration: BoxDecoration(
        color: theme.colorScheme.primary,
        borderRadius: BorderRadius.circular(AppBorderRadius.sm),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            Icons.near_me,
            size: 12,
            color: theme.colorScheme.onPrimary,
          ),
          const SizedBox(width: AppSpacing.xs),
          Text(
            DistanceUtils.formatDistanceShort(distanceKm),
            style: theme.textTheme.labelSmall?.copyWith(
              color: theme.colorScheme.onPrimary,
              fontWeight: FontWeight.w700,
            ),
          ),
        ],
      ),
    );
  }
}

class _Tag extends StatelessWidget {
  final String text;

  const _Tag({required this.text});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm, vertical: 2),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(AppBorderRadius.sm),
      ),
      child: Text(text, style: theme.textTheme.labelSmall),
    );
  }
}
