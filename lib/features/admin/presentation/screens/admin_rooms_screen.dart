import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/index.dart';
import '../../../../models/room_model.dart';
import '../providers/admin_providers.dart';
import '../widgets/admin_scaffold.dart';

class AdminRoomsScreen extends ConsumerStatefulWidget {
  const AdminRoomsScreen({super.key});

  @override
  ConsumerState<AdminRoomsScreen> createState() => _AdminRoomsScreenState();
}

class _AdminRoomsScreenState extends ConsumerState<AdminRoomsScreen> {
  /// Currently applied status filter. `null` means "all statuses".
  RoomStatus? _statusFilter;

  /// The free-text search term. An empty string means "no search".
  String _searchTerm = '';

  final _searchController = TextEditingController();

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  /// Filters the rooms by title, city or owner id.
  ///
  /// The search happens in the app, not in the Firestore query: the admin
  /// list is small and a query per keystroke would need yet another
  /// composite index.
  List<RoomModel> _applySearch(List<RoomModel> rooms) {
    final term = _searchTerm.trim().toLowerCase();
    if (term.isEmpty) return rooms;

    return rooms.where((room) {
      return room.title.toLowerCase().contains(term) ||
          room.location.city.toLowerCase().contains(term) ||
          room.location.state.toLowerCase().contains(term) ||
          room.ownerId.toLowerCase().contains(term);
    }).toList();
  }

  @override
  Widget build(BuildContext context) {
    final roomsAsync = ref.watch(adminRoomsProvider(_statusFilter));

    return AdminScaffold(
      title: 'All Rooms',
      actions: [
        IconButton(
          icon: const Icon(Icons.search),
          tooltip: 'Search rooms',
          // The button used to be an empty `onPressed: () {}` — it looked
          // clickable but did nothing.
          onPressed: () => _showSearch(context),
        ),
        IconButton(
          icon: const Icon(Icons.filter_list),
          tooltip: 'Filter by status',
          onPressed: () => _showStatusFilter(context),
        ),
      ],
      body: Column(
        children: [
          if (_searchTerm.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(
                AppSpacing.md,
                AppSpacing.sm,
                AppSpacing.md,
                0,
              ),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      'Searching for "$_searchTerm"',
                      style: Theme.of(context).textTheme.bodySmall,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  TextButton(
                    onPressed: () {
                      _searchController.clear();
                      setState(() => _searchTerm = '');
                    },
                    child: const Text('Clear'),
                  ),
                ],
              ),
            ),
          Expanded(
            child: roomsAsync.when(
              data: (rooms) {
                final visible = _applySearch(rooms);
                if (visible.isEmpty) {
                  return Center(
                    child: Padding(
                      padding: const EdgeInsets.all(AppSpacing.md),
                      child: Text(
                        rooms.isEmpty
                            ? 'No rooms found'
                            : 'No rooms match "$_searchTerm"',
                        textAlign: TextAlign.center,
                      ),
                    ),
                  );
                }
                return ListView.builder(
                  padding: const EdgeInsets.all(AppSpacing.md),
                  itemCount: visible.length,
                  itemBuilder: (context, index) => _AdminRoomCard(
                    room: visible[index],
                    onUpdateStatus: (status) async {
                      final error = await ref
                          .read(adminControllerProvider.notifier)
                          .updateRoomStatus(visible[index].roomId, status);
                      if (!context.mounted) return;
                      context.showErrorIfAny(error);
                    },
                    onDelete: () =>
                        _confirmDeleteRoom(context, ref, visible[index]),
                    // The card itself opens the listing — the card used to
                    // carry an `InkWell` without an `onTap`, so it looked
                    // touchable but did nothing at all.
                    onOpenRoom: () =>
                        context.push('/room/${visible[index].roomId}'),
                  ),
                );
              },
              loading: () => const Center(child: CircularProgressIndicator()),
              error: (error, stack) => Center(child: Text('Error: $error')),
            ),
          ),
        ],
      ),
    );
  }

  /// Opens the search dialog.
  Future<void> _showSearch(BuildContext context) async {
    final controller = TextEditingController(text: _searchTerm);
    final term = await showDialog<String>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Search rooms'),
        content: TextField(
          controller: controller,
          autofocus: true,
          decoration: const InputDecoration(
            hintText: 'Title, city or owner id',
          ),
          onSubmitted: (value) => Navigator.pop(dialogContext, value),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, controller.text),
            child: const Text('Search'),
          ),
        ],
      ),
    );

    // The controller is disposed **after** the dialog has really gone.
    //
    // It used to be disposed right after `showDialog` returned — but the
    // dialog is still on its way out at that moment, and the text field
    // that is still mounted then asks the controller for its value. That
    // throws "A TextEditingController was used after being disposed" and
    // the search dialog crashed on the way out.
    await Future<void>.delayed(const Duration(milliseconds: 300));
    controller.dispose();

    if (!mounted) return;
    _searchController.text = term ?? '';
    setState(() => _searchTerm = term ?? '');
  }

  Future<void> _showStatusFilter(BuildContext context) async {
    final selected = await RadioFilterSheet.show<RoomStatus>(
      context,
      title: 'Filter by Status',
      options: RoomStatus.values,
      labelBuilder: (status) => status.label,
      allLabel: 'All Statuses',
      initialValue: _statusFilter,
    );
    if (!mounted) return;
    setState(() => _statusFilter = selected);
  }

  void _confirmDeleteRoom(BuildContext context, WidgetRef ref, RoomModel room) {
    final screenContext = context;
    showDialog(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Delete Room'),
        content: Text(
          'Are you sure you want to delete "${room.title}"? Open requests will '
          'be cancelled. A room with an active booking or a pending payment '
          'cannot be deleted.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () async {
              Navigator.pop(dialogContext);
              final error = await ref
                  .read(adminControllerProvider.notifier)
                  .deleteRoom(room.roomId);
              if (!screenContext.mounted) return;
              screenContext.showErrorIfAny(error);
            },
            style: TextButton.styleFrom(foregroundColor: Colors.red),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
  }
}

class _AdminRoomCard extends ConsumerWidget {
  final RoomModel room;
  final ValueChanged<RoomStatus> onUpdateStatus;
  final VoidCallback onDelete;
  final VoidCallback onOpenRoom;

  const _AdminRoomCard({
    required this.room,
    required this.onUpdateStatus,
    required this.onDelete,
    required this.onOpenRoom,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);

    Color statusColor;
    switch (room.status) {
      case RoomStatus.available:
        statusColor = Colors.green;
        break;
      case RoomStatus.occupied:
        statusColor = Colors.orange;
        break;
      case RoomStatus.inactive:
        statusColor = Colors.grey;
        break;
    }

    return Card(
      margin: const EdgeInsets.only(bottom: AppSpacing.md),
      child: InkWell(
        onTap: onOpenRoom,
        borderRadius: BorderRadius.circular(AppBorderRadius.lg),
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.md),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 72,
                height: 72,
                decoration: BoxDecoration(
                  color: theme.colorScheme.surfaceContainerHighest,
                  borderRadius: BorderRadius.circular(AppBorderRadius.md),
                ),
                child: room.hasImages
                    ? GestureDetector(
                        onTap: () => RoomImageViewer.show(
                          context,
                          imageUrls: room.images,
                        ),
                        child: ClipRRect(
                          borderRadius: BorderRadius.circular(
                            AppBorderRadius.md,
                          ),
                          child: Image.network(
                            room.primaryImage,
                            fit: BoxFit.cover,
                            width: 72,
                            height: 72,
                          ),
                        ),
                      )
                    : const Icon(Icons.image, size: 28),
              ),
              const SizedBox(width: AppSpacing.md),
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
                    Text(
                      'Owner: ${room.ownerId}',
                      style: theme.textTheme.bodySmall,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    const SizedBox(height: AppSpacing.xs),
                    // The rent and the status are in a `Wrap` and not in a
                    // `Row`: on a narrow phone they did not fit side by
                    // side and the badge ran off the card.
                    Wrap(
                      spacing: AppSpacing.sm,
                      runSpacing: AppSpacing.xs,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: [
                        Text(
                          '₹${room.monthlyRent.toInt()}/month',
                          style: theme.textTheme.bodyMedium,
                        ),
                        Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: AppSpacing.sm,
                            vertical: AppSpacing.xs,
                          ),
                          decoration: BoxDecoration(
                            color: statusColor.withValues(alpha: 0.1),
                            borderRadius: BorderRadius.circular(
                              AppBorderRadius.full,
                            ),
                          ),
                          child: Text(
                            room.status.label,
                            style: theme.textTheme.labelSmall?.copyWith(
                              color: statusColor,
                            ),
                          ),
                        ),
                      ],
                    ),
                    Text(
                      '${room.location.city}, ${room.location.state} • ${room.roomType.label}',
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ],
                ),
              ),
              PopupMenuButton<String>(
                tooltip: 'Actions',
                onSelected: (value) {
                  switch (value) {
                    case 'status':
                      _showStatusDialog(context);
                      break;
                    case 'delete':
                      onDelete();
                      break;
                  }
                },
                itemBuilder: (context) => [
                  const PopupMenuItem(
                    value: 'status',
                    child: Text('Change Status'),
                  ),
                  const PopupMenuItem(
                    value: 'delete',
                    child: Text('Delete Room'),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  void _showStatusDialog(BuildContext context) {
    showDialog(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Change Room Status'),
        content: RadioGroup<RoomStatus>(
          groupValue: room.status,
          onChanged: (value) {
            if (value != null) {
              Navigator.pop(dialogContext);
              if (value == RoomStatus.available && room.currentOccupancy > 0) {
                _confirmAvailabilityRelease(context, value);
              } else {
                onUpdateStatus(value);
              }
            }
          },
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: RoomStatus.values
                .map(
                  (status) => RadioListTile<RoomStatus>(
                    title: Text(status.label),
                    value: status,
                  ),
                )
                .toList(),
          ),
        ),
      ),
    );
  }

  Future<void> _confirmAvailabilityRelease(
    BuildContext context,
    RoomStatus status,
  ) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Release the joined students?'),
        content: const Text(
          'Making this room available ends every active booking for it and '
          'removes those students immediately. Their other joined rooms are '
          'not affected. Payment and invoice history is kept unchanged.',
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
    if (confirmed == true && context.mounted) onUpdateStatus(status);
  }
}
