import 'dart:async';

import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/index.dart';
import '../../../../../firebase/student/student_repository.dart';
import '../../../../../models/room_model.dart';
import '../../../../../services/user_location_provider.dart';
import '../providers/student_providers.dart';

class StudentSearchScreen extends ConsumerStatefulWidget {
  const StudentSearchScreen({super.key});

  @override
  ConsumerState<StudentSearchScreen> createState() =>
      _StudentSearchScreenState();
}

class _StudentSearchScreenState extends ConsumerState<StudentSearchScreen> {
  final _searchController = TextEditingController();

  /// Debounces the free-text search.
  ///
  /// Every keystroke used to rebuild the provider, which re-subscribed to
  /// the Firestore stream and re-ran the whole query — typing "Koramangala"
  /// fired thirteen queries.
  Timer? _debounce;

  @override
  void initState() {
    super.initState();
    _searchController.text = ref.read(roomSearchFiltersProvider).searchTerm;
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _searchController.dispose();
    super.dispose();
  }

  void _updateFilters(RoomSearchFilters filters) {
    ref.read(roomSearchFiltersProvider.notifier).state = filters;
  }

  /// Updates the search term, but only after the user stopped typing.
  void _onSearchChanged(String value) {
    _debounce?.cancel();
    _debounce = Timer(AppConstants.debounceDuration, () {
      if (!mounted) return;
      _updateFilters(
        ref.read(roomSearchFiltersProvider).copyWith(searchTerm: value),
      );
    });
  }

  /// Loads the next cursor page and appends it to the current result.
  Future<void> _loadMoreRooms(
    BuildContext context,
    WidgetRef ref,
    List<RoomModel> currentRooms,
  ) async {
    final screenContext = context;
    final knownIds = currentRooms.map((room) => room.roomId).toSet();
    await ref.read(roomSearchPaginationProvider.notifier).loadMore(knownIds);
    if (!screenContext.mounted) return;

    final error = ref.read(roomSearchPaginationProvider).valueOrNull?.error;
    if (error != null && error.isNotEmpty) {
      screenContext.showErrorSnackBar('Could not load more rooms: $error');
    }
  }

  @override
  Widget build(BuildContext context) {
    final filters = ref.watch(roomSearchFiltersProvider);
    final roomsAsync = ref.watch(filteredRoomsProvider);
    final paginationAsync = ref.watch(roomSearchPaginationProvider);
    final location = ref.watch(userLocationProvider);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Search Rooms'),
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(104),
          child: Column(
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(
                  AppSpacing.md,
                  0,
                  AppSpacing.md,
                  AppSpacing.sm,
                ),
                child: TextField(
                  controller: _searchController,
                  textInputAction: TextInputAction.search,
                  decoration: InputDecoration(
                    hintText: 'Search by location, area...',
                    prefixIcon: const Icon(Icons.search),
                    suffixIcon: filters.searchTerm.isNotEmpty
                        ? IconButton(
                            icon: const Icon(Icons.clear),
                            onPressed: () {
                              _debounce?.cancel();
                              _searchController.clear();
                              _updateFilters(
                                ref
                                    .read(roomSearchFiltersProvider)
                                    .copyWith(searchTerm: ''),
                              );
                            },
                          )
                        : null,
                    filled: true,
                    fillColor: Theme.of(context).colorScheme.surface,
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(AppBorderRadius.md),
                      borderSide: BorderSide.none,
                    ),
                  ),
                  onChanged: _onSearchChanged,
                  onSubmitted: (value) {
                    _debounce?.cancel();
                    _updateFilters(
                      ref
                          .read(roomSearchFiltersProvider)
                          .copyWith(searchTerm: value),
                    );
                  },
                ),
              ),
              _buildLocationBar(context, location),
            ],
          ),
        ),
      ),
      body: Column(
        children: [
          _buildFilters(context, filters),
          const Divider(height: 1),
          Expanded(
            child: roomsAsync.when(
              loading: () => const Center(child: CircularProgressIndicator()),
              error: (error, _) => _ErrorState(
                message: 'Could not load rooms',
                onRetry: () {
                  ref.invalidate(filteredRoomsProvider);
                  ref.invalidate(roomSearchPaginationProvider);
                },
              ),
              data: (firstPageRooms) {
                final pagination = paginationAsync.valueOrNull;
                final additionalRooms =
                    pagination?.rooms ?? const <RoomModel>[];
                final seen = <String>{};
                final combined = <RoomModel>[];
                for (final room in [...firstPageRooms, ...additionalRooms]) {
                  if (!seen.add(room.roomId)) continue;
                  combined.add(room);
                }
                final rooms = StudentRepository.sortRooms(
                  combined,
                  filters.sort,
                  latitude: location?.latitude,
                  longitude: location?.longitude,
                );

                // Until the first explicit page request, another page may
                // still exist. This keeps a selective filter from hiding
                // deeper matches behind a page which happened to contain
                // none of them.
                final canLoadMore = pagination?.hasMore ?? true;
                if (rooms.isEmpty && !canLoadMore) {
                  return _ErrorState(
                    message: filters.hasActiveFilters
                        ? 'No rooms match your filters.'
                        : 'No rooms have been listed yet. Check back soon.',
                    onRetry: filters.hasActiveFilters
                        ? () => _clearFilters(filters)
                        : null,
                  );
                }

                final extraItems = canLoadMore ? (rooms.isEmpty ? 2 : 1) : 0;
                return ListView.builder(
                  padding: const EdgeInsets.all(AppSpacing.md),
                  itemCount: rooms.length + extraItems,
                  itemBuilder: (context, index) {
                    if (rooms.isEmpty && index == 0) {
                      return const Padding(
                        padding: EdgeInsets.only(bottom: AppSpacing.md),
                        child: Center(
                          child: Text('No rooms in this page yet.'),
                        ),
                      );
                    }

                    final roomIndex = rooms.isEmpty ? index - 1 : index;
                    if (roomIndex < rooms.length) {
                      final room = rooms[roomIndex];
                      return Padding(
                        padding: const EdgeInsets.only(bottom: AppSpacing.md),
                        child: RoomCard(
                          room: room,
                          distanceKm: roomDistanceFromUser(room, location),
                        ),
                      );
                    }

                    final loading = pagination?.isLoadingMore == true;
                    return Padding(
                      padding: const EdgeInsets.only(bottom: AppSpacing.md),
                      child: FilledButton.tonalIcon(
                        onPressed: loading
                            ? null
                            : () => _loadMoreRooms(context, ref, rooms),
                        icon: loading
                            ? const SizedBox.square(
                                dimension: 18,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                ),
                              )
                            : const Icon(Icons.expand_more),
                        label: Text(
                          loading ? 'Loading more rooms…' : 'Load more rooms',
                        ),
                      ),
                    );
                  },
                );
              },
            ),
          ),
        ],
      ),
    );
  }

  /// Shows where the user currently is.
  Widget _buildLocationBar(BuildContext context, UserLocation? location) {
    final theme = Theme.of(context);

    if (location == null) {
      return Padding(
        padding: const EdgeInsets.fromLTRB(
          AppSpacing.md,
          0,
          AppSpacing.md,
          AppSpacing.sm,
        ),
        child: Row(
          children: [
            Icon(
              Icons.location_searching,
              size: 16,
              color: theme.colorScheme.onSurfaceVariant,
            ),
            const SizedBox(width: AppSpacing.xs),
            Expanded(
              child: Text(
                'Location unavailable — distances are hidden',
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ),
            TextButton.icon(
              onPressed: () async {
                await ref.read(userLocationProvider.notifier).refresh();
              },
              icon: const Icon(Icons.refresh, size: 16),
              label: const Text('Retry'),
            ),
          ],
        ),
      );
    }

    final place = location.label.isEmpty ? 'your location' : location.label;

    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.md,
        0,
        AppSpacing.md,
        AppSpacing.sm,
      ),
      child: Row(
        children: [
          Icon(Icons.my_location, size: 16, color: theme.colorScheme.primary),
          const SizedBox(width: AppSpacing.xs),
          Expanded(
            child: Text(
              'Showing rooms near $place',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          TextButton.icon(
            onPressed: () async {
              // The lookup can fail (no permission, GPS off) — the
              // notifier handles that and simply keeps the old location.
              final location = await ref
                  .read(userLocationProvider.notifier)
                  .refresh();
              if (!context.mounted) return;
              if (location == null) {
                context.showErrorSnackBar(
                  'Could not get your location — check the location '
                  'permission and try again',
                );
              }
            },
            icon: const Icon(Icons.refresh, size: 16),
            label: const Text('Update'),
          ),
        ],
      ),
    );
  }

  Widget _buildFilters(BuildContext context, RoomSearchFilters filters) {
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      padding: const EdgeInsets.all(AppSpacing.md),
      child: Row(
        children: [
          _buildSortDropdown(context, filters),
          const SizedBox(width: AppSpacing.md),
          _buildDistanceFilter(context, filters),
          const SizedBox(width: AppSpacing.md),
          _buildRoomTypeFilter(context, filters),
          const SizedBox(width: AppSpacing.md),
          _buildFurnishingFilter(context, filters),
          const SizedBox(width: AppSpacing.md),
          _buildGenderFilter(context, filters),
          const SizedBox(width: AppSpacing.md),
          _buildRentFilter(context, filters),
          if (filters.hasActiveFilters) ...[
            const SizedBox(width: AppSpacing.md),
            ActionChip(
              avatar: const Icon(Icons.clear, size: 18),
              label: const Text('Clear all'),
              onPressed: () => _clearFilters(filters),
            ),
          ],
        ],
      ),
    );
  }

  void _clearFilters(RoomSearchFilters filters) {
    _updateFilters(
      filters.copyWith(
        clearRoomType: true,
        clearFurnishing: true,
        clearGenderPreference: true,
        clearMaxRent: true,
        clearCity: true,
        clearMaxDistanceKm: true,
        amenities: const [],
      ),
    );
  }

  Widget _buildSortDropdown(BuildContext context, RoomSearchFilters filters) {
    // The selected value lives in the shared filter state, so the dropdown
    // and the result list can never disagree. It used to be a local field
    // that was never read by the query — the rooms were always sorted the
    // same way, no matter what the user picked.
    final current = AppConstants.sortOptions.contains(filters.sort)
        ? filters.sort
        : 'relevance';

    return DropdownButton<String>(
      value: current,
      items: AppConstants.sortOptions.map((option) {
        return DropdownMenuItem(
          value: option,
          child: Text(AppConstants.sortLabels[option] ?? option),
        );
      }).toList(),
      onChanged: (value) {
        if (value == null) return;
        _updateFilters(filters.copyWith(sort: value));
      },
      underline: const SizedBox(),
    );
  }

  /// The distance filter.
  ///
  /// It only offers the limits that make sense for the current location —
  /// a "within 1 km" filter is pointless when the user is 40 km away from
  /// everything.
  Widget _buildDistanceFilter(BuildContext context, RoomSearchFilters filters) {
    return PopupMenuButton<Object>(
      onSelected: (value) => _updateFilters(
        value is double
            ? filters.copyWith(maxDistanceKm: value)
            : filters.copyWith(clearMaxDistanceKm: true),
      ),
      itemBuilder: (context) => [
        const PopupMenuItem<Object>(
          value: _anyFilter,
          child: Text('Any distance'),
        ),
        ...AppConstants.distanceOptions
            .where((km) => km != null)
            .map(
              (km) => PopupMenuItem<Object>(
                value: km,
                child: Text(AppConstants.distanceOptionLabel(km)),
              ),
            ),
      ],
      child: Chip(
        avatar: Icon(
          Icons.near_me_outlined,
          size: 18,
          color: filters.maxDistanceKm != null
              ? Theme.of(context).colorScheme.primary
              : null,
        ),
        label: Text(
          filters.maxDistanceKm == null
              ? 'Distance'
              : AppConstants.distanceOptionLabel(filters.maxDistanceKm),
        ),
      ),
    );
  }

  Widget _buildRoomTypeFilter(BuildContext context, RoomSearchFilters filters) {
    return PopupMenuButton<Object>(
      onSelected: (value) => _updateFilters(
        value is RoomType
            ? filters.copyWith(roomType: value)
            : filters.copyWith(clearRoomType: true),
      ),
      itemBuilder: (context) => [
        const PopupMenuItem<Object>(
          value: _anyFilter,
          child: Text('All room types'),
        ),
        ...RoomType.values.map(
          (type) => PopupMenuItem<Object>(value: type, child: Text(type.label)),
        ),
      ],
      child: Chip(
        label: Text(filters.roomType?.label ?? 'Room Type'),
        avatar: const Icon(Icons.filter_list, size: 18),
      ),
    );
  }

  Widget _buildFurnishingFilter(
    BuildContext context,
    RoomSearchFilters filters,
  ) {
    return PopupMenuButton<Object>(
      onSelected: (value) => _updateFilters(
        value is FurnishingType
            ? filters.copyWith(furnishing: value)
            : filters.copyWith(clearFurnishing: true),
      ),
      itemBuilder: (context) => [
        const PopupMenuItem<Object>(
          value: _anyFilter,
          child: Text('Any furnishing'),
        ),
        ...FurnishingType.values.map(
          (type) => PopupMenuItem<Object>(value: type, child: Text(type.label)),
        ),
      ],
      child: Chip(
        label: Text(filters.furnishing?.label ?? 'Furnishing'),
        avatar: const Icon(Icons.filter_list, size: 18),
      ),
    );
  }

  Widget _buildGenderFilter(BuildContext context, RoomSearchFilters filters) {
    return PopupMenuButton<Object>(
      onSelected: (value) => _updateFilters(
        value is GenderPreference
            ? filters.copyWith(genderPreference: value)
            : filters.copyWith(clearGenderPreference: true),
      ),
      itemBuilder: (context) => [
        const PopupMenuItem<Object>(
          value: _anyFilter,
          child: Text('Any preference'),
        ),
        ...GenderPreference.values.map(
          (pref) => PopupMenuItem<Object>(value: pref, child: Text(pref.label)),
        ),
      ],
      child: Chip(
        label: Text(filters.genderPreference?.label ?? 'Preference'),
        avatar: const Icon(Icons.filter_list, size: 18),
      ),
    );
  }

  Widget _buildRentFilter(BuildContext context, RoomSearchFilters filters) {
    return PopupMenuButton<Object>(
      onSelected: (value) => _updateFilters(
        value is double
            ? filters.copyWith(maxRent: value)
            : filters.copyWith(clearMaxRent: true),
      ),
      itemBuilder: (context) => [
        const PopupMenuItem<Object>(value: _anyFilter, child: Text('Any rent')),
        const PopupMenuItem<Object>(
          value: 10000.0,
          child: Text('Under ₹10,000'),
        ),
        const PopupMenuItem<Object>(
          value: 15000.0,
          child: Text('Under ₹15,000'),
        ),
        const PopupMenuItem<Object>(
          value: 25000.0,
          child: Text('Under ₹25,000'),
        ),
      ],
      child: Chip(
        label: Text(
          filters.maxRent == null
              ? 'Rent'
              : 'Under ${AppFormatters.formatCurrency(filters.maxRent!)}',
        ),
        avatar: const Icon(Icons.filter_list, size: 18),
      ),
    );
  }
}

/// Sentinel used by the filter menus for the "no filter" entry.
///
/// Flutter **never** calls `onSelected` when the selected item's value is
/// `null` — the popup just closes and the callback is skipped. The "All
/// room types" / "Any furnishing" / "Any preference" / "Any rent" entries
/// therefore could never clear an active filter. A non-null sentinel fixes
/// that.
const Object _anyFilter = _AnyFilter();

class _AnyFilter {
  const _AnyFilter();
}

class _ErrorState extends StatelessWidget {
  final String message;
  final VoidCallback? onRetry;

  const _ErrorState({required this.message, this.onRetry});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.xl),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.search_off, size: 64, color: theme.colorScheme.outline),
            const SizedBox(height: AppSpacing.md),
            Text(
              message,
              style: theme.textTheme.bodyLarge,
              textAlign: TextAlign.center,
            ),
            if (onRetry != null) ...[
              const SizedBox(height: AppSpacing.md),
              TextButton(
                onPressed: onRetry,
                child: const Text('Reset filters'),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
