import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/index.dart';
import '../../../../../firebase/owner/owner_repository.dart';
import '../../../../../models/room_model.dart';
import '../providers/owner_providers.dart';

class MyRoomsScreen extends ConsumerWidget {
  const MyRoomsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final roomsAsync = ref.watch(myRoomsProvider);
    final homes = ref.watch(ownerHomesProvider);

    return Scaffold(
      appBar: AppBar(
        title: const Text('My Rooms'),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: () => ref.invalidate(myRoomsProvider),
          ),
          IconButton(
            icon: const Icon(Icons.add),
            onPressed: () => context.push('/owner/rooms/create'),
          ),
        ],
      ),
      body: roomsAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, _) => Center(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(
                Icons.error_outline,
                size: 64,
                color: Theme.of(context).colorScheme.error,
              ),
              const SizedBox(height: AppSpacing.md),
              const Text('Could not load your listings'),
              const SizedBox(height: AppSpacing.md),
              TextButton(
                onPressed: () => ref.invalidate(myRoomsProvider),
                child: const Text('Retry'),
              ),
            ],
          ),
        ),
        data: (rooms) {
          if (rooms.isEmpty) {
            return EmptyState(
              icon: Icons.apartment_outlined,
              title: 'No Listings Yet',
              message: 'List your first room so students can find it.',
              actionLabel: 'Add a Room',
              onAction: () => context.push('/owner/rooms/create'),
            );
          }

          return RefreshIndicator(
            onRefresh: () async {
              // The indicator has to wait for the **new** data —
              // `invalidate` returns nothing, so the spinner
              // disappeared while the list was still loading.
              final _ = await ref.refresh(myRoomsProvider.future);
            },
            child: ListView.builder(
              padding: const EdgeInsets.all(AppSpacing.md),
              itemCount: homes.length,
              itemBuilder: (context, index) {
                final home = homes[index];
                return Padding(
                  padding: const EdgeInsets.only(bottom: AppSpacing.lg),
                  child: _HomeSection(home: home),
                );
              },
            ),
          );
        },
      ),
    );
  }
}

/// One home with all the rooms the owner published in it.
class _HomeSection extends ConsumerWidget {
  final OwnerHome home;

  const _HomeSection({required this.home});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          padding: const EdgeInsets.all(AppSpacing.md),
          decoration: BoxDecoration(
            color: theme.colorScheme.primaryContainer,
            borderRadius: BorderRadius.circular(AppBorderRadius.lg),
          ),
          child: Row(
            children: [
              Icon(
                Icons.home_work_outlined,
                color: theme.colorScheme.onPrimaryContainer,
              ),
              const SizedBox(width: AppSpacing.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      home.name,
                      style: theme.textTheme.titleMedium?.copyWith(
                        color: theme.colorScheme.onPrimaryContainer,
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    const SizedBox(height: AppSpacing.xs),
                    Text(
                      '${home.roomCount} room${home.roomCount == 1 ? '' : 's'}'
                      ' · ${home.availableCount} available'
                      ' · ${home.occupiedCount} occupied',
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onPrimaryContainer,
                      ),
                    ),
                  ],
                ),
              ),
              IconButton(
                tooltip: 'Add another room here',
                icon: const Icon(Icons.add_circle_outline),
                color: theme.colorScheme.onPrimaryContainer,
                onPressed: () => context.push(
                  '/owner/rooms/create?homeId=${Uri.encodeComponent(home.id)}',
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: AppSpacing.md),
        ...home.rooms.map(
          (room) => Padding(
            padding: const EdgeInsets.only(bottom: AppSpacing.md),
            child: _RoomManagementCard(room: room),
          ),
        ),
      ],
    );
  }
}

class _RoomManagementCard extends ConsumerStatefulWidget {
  final RoomModel room;

  const _RoomManagementCard({required this.room});

  @override
  ConsumerState<_RoomManagementCard> createState() =>
      _RoomManagementCardState();
}

class _RoomManagementCardState extends ConsumerState<_RoomManagementCard> {
  /// Whether the occupancy is being changed right now.
  ///
  /// The button used to stay enabled while the write was on its way: a
  /// second tap started a **second** write, and the two of them fought
  /// each other (one succeeded, the other one failed and replaced the
  /// success message with an error).
  bool _busy = false;

  RoomModel get room => widget.room;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isOccupied = room.isOccupied;

    return AppCard(
      margin: EdgeInsets.zero,
      padding: EdgeInsets.zero,
      onTap: () => context.push('/owner/rooms/edit/${room.roomId}'),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          AppImage(
            imageUrl: room.primaryImage.isEmpty ? null : room.primaryImage,
            width: double.infinity,
            height: 120,
            onTap: room.hasImages
                ? () => RoomImageViewer.show(context, imageUrls: room.images)
                : null,
            borderRadius: const BorderRadius.vertical(
              top: Radius.circular(AppBorderRadius.lg),
            ),
            placeholder: Container(
              height: 120,
              color: theme.colorScheme.surfaceContainerHighest,
              child: const Center(
                child: Icon(Icons.bedroom_parent_outlined, size: 36),
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.all(AppSpacing.md),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            room.title,
                            style: theme.textTheme.titleMedium,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                          const SizedBox(height: AppSpacing.xs),
                          Text(
                            '${AppFormatters.formatCurrency(room.monthlyRent)}/month',
                            style: theme.textTheme.bodyMedium,
                          ),
                          const SizedBox(height: AppSpacing.xs),
                          // A `Wrap` instead of a `Row`: the badge and the
                          // text did not fit next to each other on a narrow
                          // phone.
                          Wrap(
                            spacing: AppSpacing.sm,
                            runSpacing: AppSpacing.xs,
                            crossAxisAlignment: WrapCrossAlignment.center,
                            children: [
                              _StatusBadge(status: room.status),
                              Text(
                                '${room.currentOccupancy}/${room.occupancy} occupied',
                                style: theme.textTheme.bodySmall,
                              ),
                            ],
                          ),
                        ],
                      ),
                    ),
                    Icon(
                      Icons.chevron_right,
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ],
                ),
                const SizedBox(height: AppSpacing.md),
                const Divider(height: 1),
                const SizedBox(height: AppSpacing.sm),
                // The owner can take a listing off the market. The server
                // maintains the tenant count and, when a listing with joined
                // students is made available, ends those bookings in the
                // same transaction.
                //
                // A `Wrap` is used instead of a `Row`: the button has an
                // intrinsic width, and next to the text it did not fit on a
                // narrow phone — the two ran into each other.
                Wrap(
                  spacing: AppSpacing.sm,
                  runSpacing: AppSpacing.sm,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 260),
                      child: Text(
                        // An inactive listing is **not** available: students
                        // cannot find it and they cannot book it. The old
                        // wording claimed the opposite.
                        room.status == RoomStatus.inactive
                            ? 'This listing is inactive — students cannot book it.'
                            : room.currentOccupancy > 0
                            ? 'This room has joined students. Making it available ends their bookings immediately.'
                            : isOccupied
                            ? 'This listing is marked occupied and is not accepting requests.'
                            : 'This room is available for booking.',
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ),
                    FilledButton.tonalIcon(
                      onPressed: _busy
                          ? null
                          : () => _toggleOccupied(context, ref),
                      icon: Icon(
                        room.currentOccupancy > 0 || isOccupied
                            ? Icons.lock_open
                            : Icons.lock,
                        size: 18,
                      ),
                      label: _busy
                          ? const SizedBox(
                              width: 16,
                              height: 16,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : Text(
                              room.currentOccupancy > 0
                                  ? 'Make available & release students'
                                  : isOccupied
                                  ? 'Mark available'
                                  : 'Mark occupied',
                            ),
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

  Future<void> _toggleOccupied(BuildContext context, WidgetRef ref) async {
    if (_busy) return;

    final hasOccupants = room.currentOccupancy > 0;
    final makeAvailable = hasOccupants || room.isOccupied;

    if (hasOccupants) {
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          title: const Text('Make this room available?'),
          content: const Text(
            'This ends every active booking for this room and removes the '
            'joined students immediately. Their other joined rooms are not '
            'affected. Payment and invoice history is kept unchanged.',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialogContext, false),
              child: const Text('Keep current bookings'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(dialogContext, true),
              child: const Text('Make available'),
            ),
          ],
        ),
      );
      if (confirmed != true || !mounted) return;
    }

    setState(() => _busy = true);
    try {
      await ref
          .read(ownerRepositoryProvider)
          .setRoomOccupied(room.roomId, occupied: !makeAvailable);
      ref.invalidate(myRoomsProvider);
      ref.invalidate(myJoinRequestsProvider);
      if (!context.mounted) return;
      context.showSuccessSnackBar(
        makeAvailable
            ? hasOccupants
                  ? 'The room is available again and its joined students were removed.'
                  : 'The room is available again.'
            : 'The room is marked as occupied.',
      );
    } catch (e) {
      if (!context.mounted) return;
      context.showErrorSnackBar(e.toString().replaceFirst('Exception: ', ''));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }
}

class _StatusBadge extends StatelessWidget {
  final RoomStatus status;

  const _StatusBadge({required this.status});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final color = switch (status) {
      RoomStatus.available => theme.colorScheme.primary,
      RoomStatus.occupied => theme.colorScheme.tertiary,
      RoomStatus.inactive => theme.colorScheme.outline,
      RoomStatus.draft => theme.colorScheme.outline,
    };

    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.sm,
        vertical: AppSpacing.xs,
      ),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(AppBorderRadius.full),
      ),
      child: Text(
        status.label,
        style: theme.textTheme.labelSmall?.copyWith(color: color),
      ),
    );
  }
}
