import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/index.dart';
import '../../../../models/room_model.dart';
import '../../../../services/user_location_provider.dart';
import '../../../students/presentation/providers/student_providers.dart';
import '../../../students/presentation/screens/student_requests_screen.dart';

class JoinedRoomsScreen extends ConsumerWidget {
  const JoinedRoomsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final roomsAsync = ref.watch(myJoinedRoomsProvider);
    final location = ref.watch(userLocationProvider);

    return DefaultTabController(
      length: 2,
      child: Scaffold(
        appBar: AppBar(
          title: const Text('My Rooms'),
          actions: [
            IconButton(
              icon: const Icon(Icons.refresh),
              onPressed: () {
                ref.invalidate(myJoinedRoomsProvider);
                ref.invalidate(myJoinRequestsProvider);
              },
            ),
          ],
          bottom: const TabBar(
            tabs: [
              Tab(text: 'Joined Rooms'),
              Tab(text: 'Requests'),
            ],
          ),
        ),
        body: TabBarView(
          children: [
            _buildJoinedRooms(context, ref, roomsAsync, location),
            const StudentRequestsView(),
          ],
        ),
      ),
    );
  }

  Widget _buildJoinedRooms(
    BuildContext context,
    WidgetRef ref,
    AsyncValue<List<RoomModel>> roomsAsync,
    UserLocation? location,
  ) {
    return roomsAsync.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (error, _) => Center(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.xl),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(Icons.error_outline, size: 64, color: Theme.of(context).colorScheme.error),
              const SizedBox(height: AppSpacing.md),
              const Text('Could not load your rooms'),
              const SizedBox(height: AppSpacing.md),
              TextButton(
                onPressed: () => ref.invalidate(myJoinedRoomsProvider),
                child: const Text('Retry'),
              ),
            ],
          ),
        ),
      ),
      data: (rooms) {
        if (rooms.isEmpty) {
          return Center(
            child: Padding(
              padding: const EdgeInsets.all(32),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(
                    Icons.assignment_outlined,
                    size: 80,
                    color: Theme.of(context).colorScheme.outline,
                  ),
                  const SizedBox(height: 16),
                  Text(
                    'No Joined Rooms Yet',
                    style: Theme.of(context).textTheme.headlineSmall,
                  ),
                  const SizedBox(height: 8),
                  Text(
                    'When you join a room, it will appear here.',
                    style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                          color: Theme.of(context).colorScheme.onSurfaceVariant,
                        ),
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: 24),
                  AppButton(
                    label: 'Browse Rooms',
                    onPressed: () => context.go('/student/search'),
                  ),
                ],
              ),
            ),
          );
        }

        return RefreshIndicator(
          onRefresh: () async {
              // The indicator has to wait for the **new** data —
              // `invalidate` returns nothing, so the spinner
              // disappeared while the list was still loading.
              final _ = await ref.refresh(myJoinedRoomsProvider.future);
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
    );
  }
}
