import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/index.dart';
import '../../../../../models/room_model.dart';
import '../../../../../services/user_location_provider.dart';
import '../../../notifications/presentation/widgets/notification_bell.dart';
import '../providers/student_providers.dart';

class StudentHomeScreen extends ConsumerWidget {
  const StudentHomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final roomsAsync = ref.watch(roomsSearchProvider);
    final location = ref.watch(userLocationProvider);
    final requestsAsync = ref.watch(myJoinRequestsProvider);

    // The number of requests that still need something from the student.
    // A request is "open" until it was rejected or cancelled.
    final openRequests = (requestsAsync.valueOrNull ?? const [])
        .where((request) => !request.isRejected && !request.isCancelled)
        .length;

    return Scaffold(
      appBar: AppBar(
        title: const Text('StayServe'),
        actions: [
          // The list of the booking requests. Without this the screen could
          // only be reached right after a booking — a student had no way
          // back to it.
          IconButton(
            icon: Badge(
              isLabelVisible: openRequests > 0,
              label: Text('$openRequests'),
              child: const Icon(Icons.assignment_outlined),
            ),
            tooltip: 'My requests',
            onPressed: () => context.go('/student/requests'),
          ),
          const NotificationBell(),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () async {
          ref.invalidate(roomsSearchProvider);
          ref.invalidate(myJoinedRoomsProvider);
        },
        child: ListView(
          padding: const EdgeInsets.all(AppSpacing.md),
          children: [
            _buildSearchBar(context),
            const SizedBox(height: AppSpacing.lg),
            _buildSectionHeader(context, 'Quick Filters', () {
              context.push('/student/search');
            }),
            const SizedBox(height: AppSpacing.md),
            _buildQuickFilters(context, ref),
            const SizedBox(height: AppSpacing.lg),
            _buildSectionHeader(context, 'Nearby Rooms', () {
              context.push('/student/search');
            }),
            const SizedBox(height: AppSpacing.md),
            roomsAsync.when(
              loading: () => const _LoadingRow(),
              error: (error, _) => _ErrorRow(
                message: 'Could not load rooms',
                onRetry: () => ref.invalidate(roomsSearchProvider),
              ),
              data: (rooms) {
                if (rooms.isEmpty) {
                  return const _EmptyRow(
                    message: 'No rooms have been listed yet. Check back soon.',
                  );
                }
                return _RoomList(rooms: rooms.take(6).toList(), location: location);
              },
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildSearchBar(BuildContext context) {
    return InkWell(
      onTap: () => context.push('/student/search'),
      borderRadius: BorderRadius.circular(AppBorderRadius.lg),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md, vertical: AppSpacing.md),
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.surface,
          borderRadius: BorderRadius.circular(AppBorderRadius.lg),
          border: Border.all(color: Theme.of(context).colorScheme.outlineVariant),
        ),
        child: Row(
          children: [
            Icon(Icons.search, color: Theme.of(context).colorScheme.onSurfaceVariant),
            const SizedBox(width: AppSpacing.sm),
            Expanded(
              child: Text(
                'Search for rooms...',
                style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                      color: Theme.of(context).colorScheme.onSurfaceVariant,
                    ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildSectionHeader(BuildContext context, String title, VoidCallback onSeeAll) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        // The title has to give way when it is long — otherwise the row
        // overflowed by 41 pixels on a 400 pixel wide phone ("Recommended
        // for You" and the "See All" button did not fit side by side).
        Expanded(
          child: Text(
            title,
            style: Theme.of(context).textTheme.titleLarge,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
        ),
        const SizedBox(width: AppSpacing.sm),
        TextButton(onPressed: onSeeAll, child: const Text('See All')),
      ],
    );
  }

  Widget _buildQuickFilters(BuildContext context, WidgetRef ref) {
    // Every chip applies a **real** filter before opening the search screen.
    // The old code pushed the search screen without touching the filter
    // state, so all five chips behaved exactly the same.
    final filters = <_QuickFilter>[
      _QuickFilter(
        label: 'Under ₹10k',
        apply: (f) => f.copyWith(maxRent: 10000),
      ),
      _QuickFilter(
        label: 'AC Rooms',
        // A real amenity filter — searching for the text "AC" also matched
        // every room whose description contained the letters "ac"
        // ("Vacant", for example).
        apply: (f) => f.copyWith(amenities: const ['AC']),
      ),
      _QuickFilter(
        label: 'Fully Furnished',
        apply: (f) => f.copyWith(furnishing: FurnishingType.fully),
      ),
      _QuickFilter(
        label: 'Single Occupancy',
        apply: (f) => f.copyWith(roomType: RoomType.single),
      ),
      _QuickFilter(
        label: 'Within 5 km',
        apply: (f) => f.copyWith(maxDistanceKm: 5),
      ),
    ];

    return SizedBox(
      height: 40,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        itemCount: filters.length,
        separatorBuilder: (_, __) => const SizedBox(width: AppSpacing.sm),
        itemBuilder: (context, index) {
          final filter = filters[index];
          return AppFilterChip(
            label: filter.label,
            onTap: () {
              // The filter is written to the shared state first, so the
              // search screen opens with it already applied.
              ref.read(roomSearchFiltersProvider.notifier).state =
                  filter.apply(ref.read(roomSearchFiltersProvider));
              context.push('/student/search');
            },
          );
        },
      ),
    );
  }
}

/// A quick filter on the student home screen.
class _QuickFilter {
  final String label;
  final RoomSearchFilters Function(RoomSearchFilters) apply;

  const _QuickFilter({required this.label, required this.apply});
}

class _RoomList extends StatelessWidget {
  final List<RoomModel> rooms;
  final UserLocation? location;

  const _RoomList({required this.rooms, this.location});

  @override
  Widget build(BuildContext context) {
    return Column(
      children: rooms
          .map(
            (room) => Padding(
              padding: const EdgeInsets.only(bottom: AppSpacing.md),
              child: RoomCard(
                room: room,
                distanceKm: roomDistanceFromUser(room, location),
              ),
            ),
          )
          .toList(),
    );
  }
}

class _LoadingRow extends StatelessWidget {
  const _LoadingRow();

  @override
  Widget build(BuildContext context) {
    return const Padding(
      padding: EdgeInsets.symmetric(vertical: AppSpacing.xl),
      child: Center(child: CircularProgressIndicator()),
    );
  }
}

class _EmptyRow extends StatelessWidget {
  final String message;

  const _EmptyRow({required this.message});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.xl),
      child: Center(
        child: Column(
          children: [
            Icon(Icons.meeting_room_outlined, size: 48, color: theme.colorScheme.outline),
            const SizedBox(height: AppSpacing.sm),
            Text(
              message,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
              textAlign: TextAlign.center,
            ),
          ],
        ),
      ),
    );
  }
}

class _ErrorRow extends StatelessWidget {
  final String message;
  final VoidCallback onRetry;

  const _ErrorRow({required this.message, required this.onRetry});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.lg),
      child: Column(
        children: [
          Icon(Icons.error_outline, size: 40, color: theme.colorScheme.error),
          const SizedBox(height: AppSpacing.sm),
          Text(message, style: theme.textTheme.bodyMedium),
          const SizedBox(height: AppSpacing.sm),
          TextButton(onPressed: onRetry, child: const Text('Retry')),
        ],
      ),
    );
  }
}
