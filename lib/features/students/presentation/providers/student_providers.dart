import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../../core/constants/enums.dart';
import '../../../auth/presentation/providers/auth_provider.dart';
import '../../../../../firebase/student/student_repository.dart';
import '../../../../../models/join_request_model.dart';
import '../../../../../models/room_model.dart';
import '../../../../../services/user_location_provider.dart';

final roomProvider = StreamProvider.autoDispose.family<RoomModel?, String>((
  ref,
  roomId,
) {
  return ref.watch(studentRepositoryProvider).watchRoom(roomId);
});

final roomsSearchProvider = StreamProvider.autoDispose<List<RoomModel>>((ref) {
  return ref.watch(studentRepositoryProvider).searchRooms();
});

/// Filter used by the student search screen.
class RoomSearchFilters {
  final String searchTerm;
  final RoomType? roomType;
  final FurnishingType? furnishing;
  final GenderPreference? genderPreference;
  final double? maxRent;
  final String? city;

  /// The amenities the room has to offer.
  ///
  /// This used to be smuggled in through [searchTerm] ("AC"), which also
  /// matched every room whose description happened to contain the letters
  /// "ac" — "Vacant" for example.
  final List<String> amenities;

  /// The maximum distance to the user, in kilometres.
  ///
  /// `null` means "no distance limit".
  final double? maxDistanceKm;

  /// How the result list is ordered.
  ///
  /// One of [AppConstants.sortOptions]. It used to live only in a local
  /// field of the search screen, which meant the dropdown changed the
  /// label but not the order of the rooms — the selected value was never
  /// read anywhere.
  final String sort;

  const RoomSearchFilters({
    this.searchTerm = '',
    this.roomType,
    this.furnishing,
    this.genderPreference,
    this.maxRent,
    this.city,
    this.amenities = const [],
    this.maxDistanceKm,
    this.sort = 'relevance',
  });

  RoomSearchFilters copyWith({
    String? searchTerm,
    RoomType? roomType,
    FurnishingType? furnishing,
    GenderPreference? genderPreference,
    double? maxRent,
    String? city,
    List<String>? amenities,
    double? maxDistanceKm,
    String? sort,
    bool clearRoomType = false,
    bool clearFurnishing = false,
    bool clearGenderPreference = false,
    bool clearMaxRent = false,
    bool clearCity = false,
    bool clearMaxDistanceKm = false,
  }) {
    return RoomSearchFilters(
      searchTerm: searchTerm ?? this.searchTerm,
      roomType: clearRoomType ? null : (roomType ?? this.roomType),
      furnishing: clearFurnishing ? null : (furnishing ?? this.furnishing),
      genderPreference: clearGenderPreference
          ? null
          : (genderPreference ?? this.genderPreference),
      maxRent: clearMaxRent ? null : (maxRent ?? this.maxRent),
      city: clearCity ? null : (city ?? this.city),
      amenities: amenities ?? this.amenities,
      maxDistanceKm: clearMaxDistanceKm
          ? null
          : (maxDistanceKm ?? this.maxDistanceKm),
      sort: sort ?? this.sort,
    );
  }

  /// Whether any filter other than the search term is active.
  bool get hasActiveFilters =>
      roomType != null ||
      furnishing != null ||
      genderPreference != null ||
      maxRent != null ||
      city != null ||
      amenities.isNotEmpty ||
      maxDistanceKm != null;
}

final roomSearchFiltersProvider = StateProvider<RoomSearchFilters>((ref) {
  return const RoomSearchFilters();
});

final filteredRoomsProvider = StreamProvider.autoDispose<List<RoomModel>>((
  ref,
) {
  final filters = ref.watch(roomSearchFiltersProvider);
  // The distance of every room is measured from the user's own position.
  final location = ref.watch(userLocationProvider);

  return ref
      .watch(studentRepositoryProvider)
      .searchRooms(
        searchTerm: filters.searchTerm,
        roomType: filters.roomType,
        furnishing: filters.furnishing,
        genderPreference: filters.genderPreference,
        maxRent: filters.maxRent,
        city: filters.city,
        amenities: filters.amenities,
        latitude: location?.latitude,
        longitude: location?.longitude,
        maxDistanceKm: filters.maxDistanceKm,
        sort: filters.sort,
      );
});

/// The additional pages of the active student search.
///
/// The first page remains in [filteredRoomsProvider] for compatibility with
/// the home and search screens. This controller owns the cursor and the
/// later pages, so loading another page never downloads the complete room
/// collection.
class RoomSearchPaginationState {
  final List<RoomModel> rooms;
  final RoomSearchCursor? cursor;
  final bool hasMore;
  final bool isLoadingMore;
  final String? error;

  const RoomSearchPaginationState({
    this.rooms = const [],
    this.cursor,
    this.hasMore = true,
    this.isLoadingMore = false,
    this.error,
  });
}

final roomSearchPaginationProvider =
    AsyncNotifierProvider.autoDispose<
      RoomSearchPaginationController,
      RoomSearchPaginationState
    >(RoomSearchPaginationController.new);

class RoomSearchPaginationController
    extends AutoDisposeAsyncNotifier<RoomSearchPaginationState> {
  /// Identifies the active filter/location sequence.
  ///
  /// A request which was already in flight when the user changed a filter
  /// must not append its old results to the new sequence.
  int _generation = 0;
  bool _disposed = false;

  @override
  Future<RoomSearchPaginationState> build() async {
    _generation += 1;
    _disposed = false;
    ref.onDispose(() => _disposed = true);

    // A changed filter or position starts a new pagination sequence. The
    // old cursor belongs to the previous query and must not be reused.
    ref.watch(roomSearchFiltersProvider);
    ref.watch(userLocationProvider);
    return const RoomSearchPaginationState();
  }

  /// Loads the next page and appends only rooms which are not shown yet.
  Future<void> loadMore(Set<String> existingRoomIds) async {
    final current = state.valueOrNull;
    if (current == null || current.isLoadingMore || !current.hasMore) return;

    state = AsyncData(
      RoomSearchPaginationState(
        rooms: current.rooms,
        cursor: current.cursor,
        hasMore: current.hasMore,
        isLoadingMore: true,
      ),
    );

    final filters = ref.read(roomSearchFiltersProvider);
    final location = ref.read(userLocationProvider);
    final repository = ref.read(studentRepositoryProvider);
    final generation = _generation;
    final knownIds = existingRoomIds.toSet();
    final appended = <RoomModel>[];
    var cursor = current.cursor;
    var hasMore = current.hasMore;

    try {
      // The first invocation re-reads the first cursor page because the
      // compatibility provider exposes only its room models, not its cursor.
      // Duplicate results are discarded. Later invocations continue after
      // the stored cursor without re-reading earlier pages.
      for (var attempt = 0; attempt < 3 && hasMore; attempt += 1) {
        final page = await repository.searchRoomsPage(
          searchTerm: filters.searchTerm,
          roomType: filters.roomType,
          furnishing: filters.furnishing,
          genderPreference: filters.genderPreference,
          maxRent: filters.maxRent,
          city: filters.city,
          amenities: filters.amenities,
          latitude: location?.latitude,
          longitude: location?.longitude,
          maxDistanceKm: filters.maxDistanceKm,
          sort: filters.sort,
          cursor: cursor,
        );
        cursor = page.cursor ?? cursor;
        hasMore = page.hasMore;

        for (final room in page.rooms) {
          if (knownIds.contains(room.roomId)) continue;
          knownIds.add(room.roomId);
          appended.add(room);
        }

        if (appended.length >= roomSearchPageSize) break;
      }

      if (_disposed || generation != _generation) return;
      state = AsyncData(
        RoomSearchPaginationState(
          rooms: [...current.rooms, ...appended],
          cursor: cursor,
          hasMore: hasMore,
        ),
      );
    } catch (error) {
      if (_disposed || generation != _generation) return;
      state = AsyncData(
        RoomSearchPaginationState(
          rooms: current.rooms,
          cursor: current.cursor,
          hasMore: current.hasMore,
          error: error.toString(),
        ),
      );
    }
  }
}

/// The distance of [room] from the user, in kilometres.
///
/// `null` when the user has no position yet, or when the room itself has no
/// coordinates.
double? roomDistanceFromUser(RoomModel room, UserLocation? location) {
  if (location == null) return null;
  return room.distanceFrom(
    latitude: location.latitude,
    longitude: location.longitude,
  );
}

final myJoinedRoomsProvider = StreamProvider.autoDispose<List<RoomModel>>((
  ref,
) {
  // Watching the auth state is important: the provider may be created
  // before Firebase has restored the current user. It is then rebuilt when
  // the user becomes available instead of remaining permanently empty.
  final uid = ref.watch(authStateProvider).valueOrNull?.uid;
  if (uid == null) return Stream.value([]);

  return ref.watch(studentRepositoryProvider).watchJoinedRoomsForUid(uid);
});

final myJoinRequestsProvider =
    StreamProvider.autoDispose<List<JoinRequestModel>>((ref) {
      return ref.watch(studentRepositoryProvider).watchMyJoinRequests();
    });

final savedRoomsProvider = StreamProvider.autoDispose<List<RoomModel>>((ref) {
  return ref.watch(studentRepositoryProvider).watchSavedRooms();
});
