import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/index.dart';
import '../../../../../services/user_location_provider.dart';
import '../providers/student_providers.dart';

class SavedRoomsScreen extends ConsumerWidget {
  const SavedRoomsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final roomsAsync = ref.watch(savedRoomsProvider);
    final location = ref.watch(userLocationProvider);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Saved Rooms'),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: () => ref.invalidate(savedRoomsProvider),
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
              const Text('Could not load your saved rooms'),
              const SizedBox(height: AppSpacing.md),
              TextButton(
                onPressed: () => ref.invalidate(savedRoomsProvider),
                child: const Text('Retry'),
              ),
            ],
          ),
        ),
        data: (rooms) {
          if (rooms.isEmpty) {
            return EmptyState(
              icon: Icons.bookmark_outline,
              title: 'No Saved Rooms',
              message: 'Tap the bookmark icon on rooms you like to save them here.',
              actionLabel: 'Browse Rooms',
              onAction: () => context.go('/student/search'),
            );
          }

          return RefreshIndicator(
            onRefresh: () async {
              // The indicator has to wait for the **new** data —
              // `invalidate` returns nothing, so the spinner
              // disappeared while the list was still loading.
              final _ = await ref.refresh(savedRoomsProvider.future);
            },
            child: ListView.builder(
              padding: const EdgeInsets.all(AppSpacing.md),
              itemCount: rooms.length,
              itemBuilder: (context, index) => Padding(
                padding: const EdgeInsets.only(bottom: AppSpacing.md),
                child: RoomCard(
                  room: rooms[index],
                  distanceKm: roomDistanceFromUser(rooms[index], location),
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}
