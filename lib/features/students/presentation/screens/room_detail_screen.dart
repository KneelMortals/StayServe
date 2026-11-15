import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:firebase_auth/firebase_auth.dart';

import '../../../../core/index.dart';
import '../../../../../firebase/index.dart';
import '../../../../../models/join_request_model.dart';
import '../../../../../models/room_model.dart';
import '../../../../../services/user_location_provider.dart';
import '../../../reviews/presentation/providers/review_providers.dart';
import '../providers/student_providers.dart';
import '../widgets/room_visit_sheet.dart';

class RoomDetailScreen extends ConsumerWidget {
  final String roomId;
  const RoomDetailScreen({required this.roomId, super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final roomAsync = ref.watch(roomProvider(roomId));

    return Scaffold(
      body: roomAsync.when(
        data: (room) {
          if (room == null) {
            return const Center(child: Text('Room not found'));
          }
          return _RoomDetailContent(room: room);
        },
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, st) => Center(child: Text('Error: $e')),
      ),
    );
  }
}

class _RoomDetailContent extends ConsumerStatefulWidget {
  final RoomModel room;
  const _RoomDetailContent({required this.room});

  @override
  ConsumerState<_RoomDetailContent> createState() => _RoomDetailContentState();
}

class _RoomDetailContentState extends ConsumerState<_RoomDetailContent> {
  bool _isSaved = false;

  /// The request that was sent from this screen.
  ///
  /// The stream of the requests needs a moment to deliver the new request.
  /// The button has to turn into "Cancel booking" **right away**, so the
  /// room and the id of the request are remembered here.
  String? _requestSentForRoomId;
  String? _requestSentRequestId;

  /// A request is being sent or cancelled — the buttons are locked while
  /// it runs, so a second tap cannot start a second request.
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _loadSavedState();
  }

  Future<void> _loadSavedState() async {
    try {
      final saved = await ref
          .read(studentRepositoryProvider)
          .isRoomSaved(widget.room.roomId);
      if (mounted) setState(() => _isSaved = saved);
    } catch (_) {
      // Not being able to read the saved state must not block the screen.
    }
  }

  Future<void> _toggleSaved() async {
    final previous = _isSaved;
    setState(() => _isSaved = !previous);

    try {
      await ref
          .read(studentRepositoryProvider)
          .toggleSavedRoom(widget.room.roomId);
      // The widget may have been closed while the write was in flight.
      if (!mounted) return;
      ref.invalidate(savedRoomsProvider);
    } catch (e) {
      if (!mounted) return;
      // Roll back the optimistic update.
      setState(() => _isSaved = previous);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(e.toString().replaceFirst('Exception: ', '')),
          backgroundColor: Theme.of(context).colorScheme.error,
        ),
      );
    }
  }

  /// The request of the current student for [roomId] that is still alive.
  ///
  /// A **cancelled** or **rejected** request is over — the student may ask
  /// for the room again, so it does not count.
  JoinRequestModel? _activeRequestFor(
    List<JoinRequestModel> requests,
    String roomId,
  ) {
    // The list comes from Firestore sorted by date, newest first — the
    // first match is the one that counts.
    for (final request in requests) {
      if (request.roomId != roomId) continue;
      if (request.isCancelled || request.isRejected) continue;
      return request;
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final room = widget.room;
    final isAvailable = room.isAvailable;
    final currentUser = ref.watch(currentUserProvider);
    final location = ref.watch(userLocationProvider);
    final distanceKm = roomDistanceFromUser(room, location);

    // -------------------------------------------------------------------
    // The owner may have accepted the request of this student.
    //
    // That is the moment the student gets the location of the room: before
    // it they only see the rough area (the city), after it they can see
    // where the room is and how to get there.
    // -------------------------------------------------------------------
    final requests = ref.watch(myJoinRequestsProvider).valueOrNull ??
        const <JoinRequestModel>[];
    final isAccepted = ownerAcceptedRequestFor(requests, room.roomId);

    // -------------------------------------------------------------------
    // The request of this student for this room.
    //
    // As long as it exists, the button of the room says "Cancel booking"
    // instead of "Request to Book" — the request must not be sent twice.
    // -------------------------------------------------------------------
    final activeRequest = _activeRequestFor(requests, room.roomId);

    return Scaffold(
      body: CustomScrollView(
        slivers: [
          _buildAppBar(context, room),
          SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.all(AppSpacing.md),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _buildRoomInfo(context, room, distanceKm, isAccepted),
                  const SizedBox(height: AppSpacing.lg),
                  _buildReviews(context, room),
                  const SizedBox(height: AppSpacing.lg),
                  _buildAmenities(context, room),
                  const SizedBox(height: AppSpacing.lg),
                  _buildOwnerInfo(context, room),
                  const SizedBox(height: AppSpacing.lg),
                  _buildActionButtons(
                    context,
                    room,
                    currentUser,
                    isAvailable,
                    isAccepted,
                    activeRequest,
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildAppBar(BuildContext context, RoomModel room) {
    return SliverAppBar(
      expandedHeight: 300,
      pinned: true,
      actions: [
        IconButton(
          tooltip: _isSaved ? 'Remove from saved' : 'Save room',
          icon: Icon(
            _isSaved ? Icons.bookmark : Icons.bookmark_border,
          ),
          onPressed: _toggleSaved,
        ),
      ],
      flexibleSpace: FlexibleSpaceBar(
        background: room.hasImages
            ? Image.network(
                room.primaryImage,
                fit: BoxFit.cover,
                errorBuilder: (_, __, ___) => Container(
                  color: Theme.of(context).colorScheme.surfaceContainerHighest,
                  child: const Center(child: Icon(Icons.image, size: 80)),
                ),
              )
            : Container(
                color: Theme.of(context).colorScheme.surfaceContainerHighest,
                child: const Center(child: Icon(Icons.image, size: 80)),
              ),
      ),
    );
  }

  Widget _buildRoomInfo(
    BuildContext context,
    RoomModel room,
    double? distanceKm,
    bool isAccepted,
  ) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(room.title, style: theme.textTheme.headlineSmall),
        const SizedBox(height: AppSpacing.sm),
        Row(
          children: [
            Icon(Icons.location_on, size: 16, color: theme.colorScheme.onSurfaceVariant),
            const SizedBox(width: AppSpacing.xs),
            Expanded(child: Text(room.location.shortAddress, style: theme.textTheme.bodyMedium)),
            if (distanceKm != null) ...[
              const SizedBox(width: AppSpacing.sm),
              Icon(Icons.near_me_outlined, size: 16, color: theme.colorScheme.primary),
              const SizedBox(width: AppSpacing.xs),
              Text(
                DistanceUtils.formatDistance(distanceKm),
                style: theme.textTheme.labelMedium?.copyWith(
                  color: theme.colorScheme.primary,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ],
          ],
        ),
        // -------------------------------------------------------------------
        // The full address is only shown once the owner accepted the request.
        //
        // Before that the student only gets the rough area — the address is
        // what the student needs to actually **visit** the room, and that is
        // only fair once the owner agreed to the booking.
        // -------------------------------------------------------------------
        if (isAccepted) ...[
          const SizedBox(height: AppSpacing.xs),
          Text(
            room.location.fullAddress,
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
        ] else if (room.location.address.trim().isNotEmpty) ...[
          const SizedBox(height: AppSpacing.xs),
          Text(
            'The exact address is shown once the owner accepts your request.',
            style: theme.textTheme.bodySmall?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
              fontStyle: FontStyle.italic,
            ),
          ),
        ],
        const SizedBox(height: AppSpacing.md),
        Row(
          children: [
            Text(
              AppFormatters.formatCurrency(room.monthlyRent),
              style: theme.textTheme.headlineMedium?.copyWith(color: theme.colorScheme.primary),
            ),
            const SizedBox(width: AppSpacing.md),
            Text(
              'Deposit: ${AppFormatters.formatCurrency(room.securityDeposit)}',
              style: theme.textTheme.bodyMedium?.copyWith(color: theme.colorScheme.onSurfaceVariant),
            ),
          ],
        ),
        const SizedBox(height: AppSpacing.lg),
        Text('Description', style: theme.textTheme.titleLarge),
        const SizedBox(height: AppSpacing.sm),
        Text(
          room.description,
          style: theme.textTheme.bodyMedium,
        ),
        const SizedBox(height: AppSpacing.lg),
        Wrap(
          spacing: AppSpacing.sm,
          runSpacing: AppSpacing.sm,
          children: [
            _InfoChip(label: room.roomType.label, icon: Icons.person),
            _InfoChip(label: room.furnishing.label, icon: Icons.chair),
            _InfoChip(label: 'Available from ${_formatDate(room.availableFrom)}', icon: Icons.calendar_today),
            _InfoChip(label: room.genderPreference.label, icon: room.genderPreference == GenderPreference.male ? Icons.male : room.genderPreference == GenderPreference.female ? Icons.female : Icons.transgender),
          ],
        ),
        const SizedBox(height: AppSpacing.md),
        Row(
          children: [
            Text('${room.availableSlots} / ${room.occupancy} slots available', style: theme.textTheme.bodyMedium),
            const Spacer(),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm, vertical: AppSpacing.xs),
              decoration: BoxDecoration(
                color: room.status == RoomStatus.available ? Colors.green.withValues(alpha: 0.1) : Colors.orange.withValues(alpha: 0.1),
                borderRadius: BorderRadius.circular(AppBorderRadius.full),
              ),
              child: Text(
                room.status.label,
                style: theme.textTheme.labelSmall?.copyWith(
                  color: room.status == RoomStatus.available ? Colors.green : Colors.orange,
                ),
              ),
            ),
          ],
        ),
      ],
    );
  }

  /// The reviews of the room — and the way into them.
  Widget _buildReviews(BuildContext context, RoomModel room) {
    final theme = Theme.of(context);
    final summary = ref.watch(roomReviewSummaryProvider(room.roomId));

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Text('Reviews', style: theme.textTheme.titleLarge),
            const SizedBox(width: AppSpacing.sm),
            if (summary.count > 0)
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(Icons.star, size: 16, color: Colors.amber),
                  const SizedBox(width: 2),
                  Text(
                    '${summary.averageLabel} (${summary.count})',
                    style: theme.textTheme.bodyMedium,
                  ),
                ],
              ),
          ],
        ),
        const SizedBox(height: AppSpacing.sm),
        InkWell(
          onTap: () => context.push('/room/${room.roomId}/reviews'),
          borderRadius: BorderRadius.circular(AppBorderRadius.md),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: AppSpacing.xs),
            child: Row(
              children: [
                Icon(
                  Icons.reviews_outlined,
                  size: 18,
                  color: theme.colorScheme.onSurfaceVariant,
                ),
                const SizedBox(width: AppSpacing.sm),
                Expanded(
                  child: Text(
                    summary.count == 0
                        ? 'No reviews yet — be the first one'
                        : 'Read all ${summary.count} review'
                            '${summary.count == 1 ? '' : 's'}',
                    style: theme.textTheme.bodyMedium,
                  ),
                ),
                Icon(
                  Icons.chevron_right,
                  size: 18,
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildAmenities(BuildContext context, RoomModel room) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Amenities', style: theme.textTheme.titleLarge),
        const SizedBox(height: AppSpacing.md),
        Wrap(
          spacing: AppSpacing.sm,
          runSpacing: AppSpacing.sm,
          children: room.amenities.map((a) => Chip(
            label: Text(a),
            avatar: Icon(Icons.check_circle, size: 16, color: theme.colorScheme.primary),
          )).toList(),
        ),
      ],
    );
  }

  Widget _buildOwnerInfo(BuildContext context, RoomModel room) {
    final theme = Theme.of(context);
    final currentUser = ref.watch(currentUserProvider);
    final isOwnRoom = currentUser != null && room.ownerId == currentUser.uid;

    return Container(
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(AppBorderRadius.lg),
      ),
      child: Row(
        children: [
          const AppAvatar(name: 'Owner', radius: 30),
          const SizedBox(width: AppSpacing.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('Room Owner', style: theme.textTheme.titleMedium),
                Text(
                  isOwnRoom ? 'This is your listing' : 'Contact to know more',
                  style: theme.textTheme.bodySmall,
                ),
              ],
            ),
          ),
          // There is no point in opening a chat with yourself.
          if (!isOwnRoom)
            AppButton(
              label: 'Message',
              onPressed: () => _openChat(context, room),
              isFullWidth: false,
              type: ButtonType.secondary,
            ),
        ],
      ),
    );
  }

  /// Opens the chat with the owner of the room.
  ///
  /// The conversation id is **not** `owner_<uid>`: the conversation document
  /// is named after the two participants (sorted and joined with an
  /// underscore). Pushing a made-up id opened a chat that did not exist —
  /// and because the chat screen looks the other participant up in the
  /// conversation list, the message input never showed up at all.
  Future<void> _openChat(BuildContext context, RoomModel room) async {
    final currentUser = ref.read(currentUserProvider);
    if (currentUser == null) {
      context.push('/login');
      return;
    }

    try {
      final conversationId = await ref
          .read(conversationRepositoryProvider)
          .openConversation(room.ownerId, roomId: room.roomId);
      if (!context.mounted) return;
      // The recipient is handed over with the route, so that the message
      // input is there right away.
      context.push('/chat/$conversationId?peer=${room.ownerId}');
    } catch (e) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            'Could not open the chat: ${e.toString().replaceFirst('Exception: ', '')}',
          ),
          backgroundColor: Theme.of(context).colorScheme.error,
        ),
      );
    }
  }

  Widget _buildActionButtons(
    BuildContext context,
    RoomModel room,
    User? currentUser,
    bool isAvailable,
    bool isAccepted,
    JoinRequestModel? activeRequest,
  ) {
    final theme = Theme.of(context);

    if (currentUser == null) {
      return Row(
        children: [
          Expanded(
            child: AppButton(
              label: 'Login to Book',
              onPressed: () => context.push('/login'),
              type: ButtonType.primary,
            ),
          ),
        ],
      );
    }

    // -------------------------------------------------------------------
    // The owner of a room cannot book it — not even their own room.
    //
    // The server rejects such a request as well, but a button that leads
    // to an error is a bug the user sees. The room is simply shown as
    // "your listing" instead.
    // -------------------------------------------------------------------
    if (room.ownerId == currentUser.uid) {
      return Container(
        width: double.infinity,
        padding: const EdgeInsets.all(AppSpacing.md),
        decoration: BoxDecoration(
          color: theme.colorScheme.primaryContainer,
          borderRadius: BorderRadius.circular(AppBorderRadius.lg),
          border: Border.all(color: theme.colorScheme.primary),
        ),
        child: Row(
          children: [
            Icon(Icons.home_work, color: theme.colorScheme.onPrimaryContainer),
            const SizedBox(width: AppSpacing.sm),
            Expanded(
              child: Text(
                'This is your listing. You cannot book your own room.',
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: theme.colorScheme.onPrimaryContainer,
                ),
              ),
            ),
          ],
        ),
      );
    }

    // -------------------------------------------------------------------
    // A request for this room already exists.
    //
    // The button says **"Cancel booking"** — not "Request to Book". The
    // request may only be sent once: the server refuses a second one with
    // "You have already requested to join this room", which the user saw
    // as a strange error message when they tapped the button a second
    // time.
    //
    // The request that was sent from this screen is remembered, so the
    // button turns around **right away** — the stream of the requests
    // needs a moment to deliver it.
    // -------------------------------------------------------------------
    final requestExists =
        activeRequest != null || _requestSentForRoomId == room.roomId;

    if (requestExists) {
      final canCancel = activeRequest?.canBeCancelled ?? true;

      // The id of the request that was sent from this screen is known even
      // before the stream delivers it — the button can cancel it right
      // away.
      final requestId = activeRequest?.requestId ?? _requestSentRequestId;

      return Column(
        children: [
          // The owner accepted the request — the student may now see where
          // the room is and get there.
          if (isAccepted) ...[
            AppButton(
              label: 'Visit the room',
              icon: const Icon(Icons.location_on_outlined),
              onPressed: () => showRoomVisitSheet(context, room.roomId),
              isFullWidth: true,
            ),
            const SizedBox(height: AppSpacing.sm),
          ],
          AppButton(
            label: 'Cancel booking',
            icon: const Icon(Icons.close),
            // A booking that already has money in it cannot be walked away
            // from — the button says so instead of letting the server
            // refuse it with an error.
            onPressed: _busy || requestId == null || !canCancel
                ? null
                : () => _cancelBooking(
                      context,
                      activeRequest ??
                          JoinRequestModel(
                            requestId: requestId,
                            roomId: room.roomId,
                            studentId: currentUser.uid,
                            ownerId: room.ownerId,
                            status: JoinRequestStatus.pending,
                            createdAt: DateTime.now(),
                            updatedAt: DateTime.now(),
                            monthlyRentAtJoin: room.monthlyRent,
                            commissionPercentageAtJoin: 30,
                          ),
                    ),
            isLoading: _busy,
            isFullWidth: true,
            type: ButtonType.danger,
          ),
          const SizedBox(height: AppSpacing.sm),
          AppButton(
            label: 'Contact Owner',
            onPressed: () => _openChat(context, room),
            isFullWidth: true,
            type: ButtonType.secondary,
          ),
          if (!canCancel && activeRequest != null) ...[
            const SizedBox(height: AppSpacing.sm),
            Text(
              'This booking cannot be cancelled any more — the money has '
              'already changed hands.',
              textAlign: TextAlign.center,
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ],
      );
    }

    if (!isAvailable) {
      return Container(
        padding: const EdgeInsets.all(AppSpacing.md),
        decoration: BoxDecoration(
          color: Colors.orange.withValues(alpha: 0.1),
          borderRadius: BorderRadius.circular(AppBorderRadius.lg),
          border: Border.all(color: Colors.orange),
        ),
        child: Row(
          children: [
            Icon(Icons.info_outline, color: Colors.orange),
            const SizedBox(width: AppSpacing.sm),
            Expanded(child: Text('This room is currently not available for booking', style: theme.textTheme.bodyMedium?.copyWith(color: Colors.orange))),
          ],
        ),
      );
    }

    return Row(
      children: [
        Expanded(
          child: AppButton(
            label: 'Contact Owner',
            onPressed: () => _openChat(context, room),
            type: ButtonType.secondary,
          ),
        ),
        const SizedBox(width: AppSpacing.md),
        Expanded(
          child: AppButton(
            label: 'Request to Book',
            onPressed: _busy ? null : () => _showBookingDialog(context, room),
            isLoading: _busy,
            type: ButtonType.primary,
          ),
        ),
      ],
    );
  }

  /// Opens the booking dialog and follows up when the request was sent.
  ///
  /// The screen stays on the room: the button turns into "Cancel booking"
  /// right away, so the student sees that the request went through. The
  /// list of the requests is one tap away.
  Future<void> _showBookingDialog(BuildContext context, RoomModel room) async {
    // The messenger is looked up **before** the dialog is opened: the screen
    // is replaced by the requests screen afterwards, and the lookup must not
    // happen on a context that is on its way out.
    final messenger = ScaffoldMessenger.of(context);

    final result = await showDialog<Object?>(
      context: context,
      builder: (dialogContext) => _BookingDialog(room: room),
    );

    if (!context.mounted) return;

    // -------------------------------------------------------------------
    // The request already existed — the server refused a second one.
    //
    // That is not an error the student has to understand: the button turns
    // into "Cancel booking" and the request that is already there is
    // shown.
    // -------------------------------------------------------------------
    if (result is _BookingOutcome && result.duplicate) {
      ref.invalidate(myJoinRequestsProvider);
      messenger.showSnackBar(
        SnackBar(
          content: const Text(
            'You have already requested this room — you can cancel the '
            'request below.',
          ),
          backgroundColor: Theme.of(context).colorScheme.error,
        ),
      );
      return;
    }

    if (result is! _BookingOutcome) return;

    // The button turns into "Cancel booking" right away.
    setState(() {
      _requestSentForRoomId = room.roomId;
      _requestSentRequestId = result.requestId;
      _busy = false;
    });
    ref.invalidate(myJoinRequestsProvider);

    messenger.showSnackBar(
      SnackBar(
        content: const Text(
          'Request sent! The owner will review it. You can pay the platform '
          'fee once they approve.',
        ),
        backgroundColor: Colors.green,
        action: SnackBarAction(
          label: 'View requests',
          onPressed: () => context.go('/student/requests'),
        ),
      ),
    );
  }

  /// Cancels the booking of this room.
  ///
  /// The student is asked first — a cancellation cannot be undone.
  Future<void> _cancelBooking(
    BuildContext context,
    JoinRequestModel request,
  ) async {
    // The messenger and the colour are taken **before** the dialog is
    // opened: the context of the button must not be used after the `await`.
    final messenger = ScaffoldMessenger.of(context);
    final errorColor = Theme.of(context).colorScheme.error;

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Cancel booking?'),
        content: const Text(
          'Your request for this room will be withdrawn. You can ask for the '
          'room again later.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('Keep booking'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('Cancel booking'),
          ),
        ],
      ),
    );

    if (confirmed != true || !mounted) return;

    setState(() => _busy = true);

    try {
      await ref.read(studentJoinRequestProvider).cancelJoinRequest(
            request.requestId,
            reason: 'Cancelled by the student from the room page',
          );
      if (!mounted) return;
      setState(() {
        _busy = false;
        _requestSentForRoomId = null;
        _requestSentRequestId = null;
      });
      ref.invalidate(myJoinRequestsProvider);
      messenger.showSnackBar(
        const SnackBar(
          content: Text('Booking cancelled'),
          backgroundColor: Colors.green,
        ),
      );
    } catch (e) {
      if (!mounted) return;
      setState(() => _busy = false);
      messenger.showSnackBar(
        SnackBar(
          content: Text(
            e.toString().replaceFirst('Exception: ', ''),
          ),
          backgroundColor: errorColor,
        ),
      );
    }
  }

  String _formatDate(DateTime date) {
    return '${date.day}/${date.month}/${date.year}';
  }
}

/// What the booking dialog tells the room page.
class _BookingOutcome {
  /// The request was sent — and this is its id.
  final String requestId;

  /// A request for this room already existed.
  final bool duplicate;

  const _BookingOutcome.created(this.requestId) : duplicate = false;

  const _BookingOutcome.duplicateExisting()
      : requestId = '',
        duplicate = true;
}

class _BookingDialog extends ConsumerStatefulWidget {
  final RoomModel room;

  const _BookingDialog({required this.room});

  @override
  ConsumerState<_BookingDialog> createState() => _BookingDialogState();
}

class _BookingDialogState extends ConsumerState<_BookingDialog> {
  bool _isProcessing = false;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final room = widget.room;

    // The fee percentage is a platform setting — the admin can change it, so
    // it is read from Firestore instead of being hardcoded.
    final settings = ref.watch(platformSettingsProvider).valueOrNull ??
        PlatformSettings.fallback;
    final feePercentage = settings.feePercentage;
    final platformFee = room.monthlyRent * (feePercentage / 100);

    return AlertDialog(
      title: const Text('Request to book'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Room: ${room.title}', style: theme.textTheme.titleMedium),
            Text('Location: ${room.location.shortAddress}', style: theme.textTheme.bodyMedium),
            const SizedBox(height: AppSpacing.md),
            Row(
              children: [
                Text('Monthly Rent: ', style: theme.textTheme.bodyMedium),
                Text(AppFormatters.formatCurrency(room.monthlyRent), style: theme.textTheme.titleMedium?.copyWith(color: theme.colorScheme.primary)),
              ],
            ),
            const SizedBox(height: AppSpacing.xs),
            Row(
              children: [
                Text('${feePercentage.toStringAsFixed(0)}% Platform Fee: ', style: theme.textTheme.bodyMedium),
                Text(AppFormatters.formatCurrency(platformFee), style: theme.textTheme.titleMedium?.copyWith(color: theme.colorScheme.primary, fontWeight: FontWeight.bold)),
              ],
            ),
            const SizedBox(height: AppSpacing.xs),
            Row(
              children: [
                Text('Security Deposit: ', style: theme.textTheme.bodyMedium),
                Text(AppFormatters.formatCurrency(room.securityDeposit), style: theme.textTheme.bodyMedium),
              ],
            ),
            const SizedBox(height: AppSpacing.lg),
            Container(
              padding: const EdgeInsets.all(AppSpacing.md),
              decoration: BoxDecoration(
                color: theme.colorScheme.primaryContainer,
                borderRadius: BorderRadius.circular(AppBorderRadius.md),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('How booking works:', style: theme.textTheme.labelLarge),
                  const SizedBox(height: AppSpacing.xs),
                  Text(
                    '• You send a request — nothing is charged right now',
                    style: theme.textTheme.bodySmall,
                  ),
                  Text(
                    '• The owner reviews and approves your request',
                    style: theme.textTheme.bodySmall,
                  ),
                  Text(
                    '• You then pay the ${feePercentage.toStringAsFixed(0)}% platform fee '
                    '(${AppFormatters.formatCurrency(platformFee)}) via UPI to ${AppConstants.platformUpiName}',
                    style: theme.textTheme.bodySmall,
                  ),
                  Text(
                    '• UPI: ${AppConstants.platformUpiVpa}',
                    style: theme.textTheme.bodySmall,
                  ),
                  Text(
                    '• The room is activated once our team verifies the payment',
                    style: theme.textTheme.bodySmall,
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: _isProcessing ? null : () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: _isProcessing ? null : () => _processBooking(),
          child: _isProcessing
              ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
              : const Text('Send Request'),
        ),
      ],
    );
  }

  Future<void> _processBooking() async {
    setState(() => _isProcessing = true);

    try {
      final room = widget.room;
      final currentUser = ref.read(currentUserProvider);
      if (currentUser == null) throw Exception('User not logged in');

      // The navigator is taken before the request is sent: the context of
      // the dialog must not be used after the `await`.
      final navigator = Navigator.of(context);

      // Create the join request. The platform fee is *not* charged here —
      // the owner has to approve first, and only then does the student get
      // a server-issued payment link from the "My Requests" screen.
      final request = await ref.read(studentJoinRequestProvider).createJoinRequest(
            roomId: room.roomId,
            ownerId: room.ownerId,
            monthlyRent: room.monthlyRent,
          );

      // The dialog is closed with the result — the screen that opened it
      // then turns the button into "Cancel booking". The id of the request
      // comes with it, so the button can cancel it right away — the stream
      // of the requests needs a moment to deliver it.
      navigator.pop(_BookingOutcome.created(request.requestId));
    } catch (e) {
      if (!mounted) return;

      // -------------------------------------------------------------------
      // A request for this room already exists.
      //
      // The server refuses a second request with "You have already
      // requested to join this room". That is not a failure the student has
      // to understand — the room page turns the button into "Cancel
      // booking" and shows the request that is already there.
      // -------------------------------------------------------------------
      final message = e.toString().replaceFirst('Exception: ', '');
      if (message.toLowerCase().contains('already requested')) {
        Navigator.of(context).pop(const _BookingOutcome.duplicateExisting());
        return;
      }

      setState(() => _isProcessing = false);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Request failed: $message'), backgroundColor: Theme.of(context).colorScheme.error),
      );
    }
  }
}

class _InfoChip extends StatelessWidget {
  final String label;
  final IconData icon;

  const _InfoChip({required this.label, required this.icon});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Chip(
      label: Text(label),
      avatar: Icon(icon, size: 16, color: theme.colorScheme.primary),
    );
  }
}