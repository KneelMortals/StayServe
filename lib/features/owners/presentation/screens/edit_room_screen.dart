import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/index.dart';
import '../../../../../firebase/owner/owner_repository.dart';
import '../../../../../models/room_model.dart';
import '../providers/owner_providers.dart';
import '../widgets/room_form.dart';

class EditRoomScreen extends ConsumerWidget {
  final String roomId;

  const EditRoomScreen({required this.roomId, super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final roomAsync = ref.watch(myRoomsProvider);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Edit Room'),
        actions: [
          if (roomAsync.valueOrNull != null)
            IconButton(
              icon: const Icon(Icons.delete_outline),
              tooltip: 'Delete listing',
              onPressed: () => _confirmDelete(context, ref),
            ),
        ],
      ),
      body: roomAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        // `skipError: true`: a stream error **after** the listing was
        // loaded does not throw the form away. The form owns the text the
        // owner has typed — replacing it with the error page lost every
        // unsaved change.
        error: (error, _) => _buildError(context, ref),
        data: (rooms) {
          RoomModel? room;
          for (final candidate in rooms) {
            if (candidate.roomId == roomId) {
              room = candidate;
              break;
            }
          }

          if (room == null) {
            return const EmptyState(
              icon: Icons.search_off,
              title: 'Listing Not Found',
              message: 'This listing may have been removed.',
            );
          }

          return RoomForm(
            initialRoom: room,
            submitLabel: 'Save Changes',
            homes: ref.watch(ownerHomesProvider),
            onSubmit: (draft) async {
              await ref.read(ownerRepositoryProvider).updateRoom(draft);
              ref.invalidate(myRoomsProvider);
            },
          );
        },
        skipError: true,
      ),
    );
  }

  /// The error page of the screen.
  Widget _buildError(BuildContext context, WidgetRef ref) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(
            Icons.error_outline,
            size: 64,
            color: Theme.of(context).colorScheme.error,
          ),
          const SizedBox(height: AppSpacing.md),
          const Text('Could not load this listing'),
          const SizedBox(height: AppSpacing.md),
          TextButton(
            onPressed: () => ref.invalidate(myRoomsProvider),
            child: const Text('Retry'),
          ),
        ],
      ),
    );
  }

  Future<void> _confirmDelete(BuildContext context, WidgetRef ref) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Delete listing?'),
        content: const Text(
          'This removes the listing and cancels its open requests. '
          'A listing with an active booking or a pending payment cannot be '
          'deleted.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );

    if (confirmed != true || !context.mounted) return;

    try {
      await ref.read(ownerRepositoryProvider).deleteRoom(roomId);
      ref.invalidate(myRoomsProvider);
      if (!context.mounted) return;
      context.go('/owner/rooms');
    } catch (e) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(e.toString().replaceFirst('Exception: ', '')),
          backgroundColor: Theme.of(context).colorScheme.error,
        ),
      );
    }
  }
}
