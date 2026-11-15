import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/index.dart';
import '../../../../firebase/reviews/review_repository.dart';
import '../../../../models/room_review_model.dart';
import '../../../students/presentation/providers/student_providers.dart';
import '../providers/review_providers.dart';

/// The reviews of a room — and the form to write one.
///
/// ## Who may write a review?
///
/// Only the students whose booking request the **owner accepted**. The
/// button is shown to exactly those students, and the server makes the very
/// same check — a modified client cannot review a room it was never
/// accepted for.
class RoomReviewsScreen extends ConsumerStatefulWidget {
  final String roomId;

  /// The title of the room — shown in the app bar.
  final String roomTitle;

  const RoomReviewsScreen({
    required this.roomId,
    this.roomTitle = 'the room',
    super.key,
  });

  @override
  ConsumerState<RoomReviewsScreen> createState() => _RoomReviewsScreenState();
}

class _RoomReviewsScreenState extends ConsumerState<RoomReviewsScreen> {
  @override
  Widget build(BuildContext context) {
    final reviewsAsync = ref.watch(roomReviewsProvider(widget.roomId));
    final summary = ref.watch(roomReviewSummaryProvider(widget.roomId));
    final requests = ref.watch(myJoinRequestsProvider).valueOrNull ??
        const [];

    final mayReview = mayReviewRoom(requests, widget.roomId);

    return Scaffold(
      appBar: AppBar(
        title: Text('Reviews of ${widget.roomTitle}'),
      ),
      body: reviewsAsync.when(
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
              const Text('Could not load the reviews'),
              const SizedBox(height: AppSpacing.md),
              TextButton(
                onPressed: () => ref.invalidate(roomReviewsProvider(widget.roomId)),
                child: const Text('Retry'),
              ),
            ],
          ),
        ),
        data: (reviews) => ListView(
          padding: const EdgeInsets.all(AppSpacing.md),
          children: [
            _SummaryCard(summary: summary),
            const SizedBox(height: AppSpacing.md),
            if (mayReview) ...[
              _WriteReviewCard(roomId: widget.roomId),
              const SizedBox(height: AppSpacing.md),
            ] else ...[
              const _ReviewHintCard(),
              const SizedBox(height: AppSpacing.md),
            ],
            if (reviews.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: AppSpacing.xl),
                child: EmptyState(
                  icon: Icons.reviews_outlined,
                  title: 'No Reviews Yet',
                  message:
                      'Nobody has reviewed this room yet. Be the first one.',
                ),
              )
            else
              ...reviews.map(
                (review) => Padding(
                  padding: const EdgeInsets.only(bottom: AppSpacing.md),
                  child: _ReviewCard(review: review),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// The average of the reviews and how they are spread out.
class _SummaryCard extends StatelessWidget {
  final ReviewSummary summary;

  const _SummaryCard({required this.summary});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return AppCard(
      margin: EdgeInsets.zero,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          Column(
            children: [
              Text(
                summary.averageLabel,
                style: theme.textTheme.headlineMedium?.copyWith(
                  color: theme.colorScheme.primary,
                  fontWeight: FontWeight.bold,
                ),
              ),
              _Stars(rating: summary.average, size: 16),
              const SizedBox(height: AppSpacing.xs),
              Text(
                summary.count == 1 ? '1 review' : '${summary.count} reviews',
                style: theme.textTheme.bodySmall,
              ),
            ],
          ),
          const SizedBox(width: AppSpacing.lg),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (var stars = 5; stars >= 1; stars--)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 2),
                    child: Row(
                      children: [
                        SizedBox(
                          width: 12,
                          child: Text(
                            '$stars',
                            style: theme.textTheme.bodySmall,
                          ),
                        ),
                        const Icon(Icons.star, size: 12, color: Colors.amber),
                        const SizedBox(width: AppSpacing.xs),
                        Expanded(
                          child: ClipRRect(
                            borderRadius:
                                BorderRadius.circular(AppBorderRadius.full),
                            child: LinearProgressIndicator(
                              value: summary.count == 0
                                  ? 0
                                  : (summary.distribution[stars] ?? 0) /
                                      summary.count,
                              minHeight: 6,
                              backgroundColor:
                                  theme.colorScheme.surfaceContainerHighest,
                              valueColor:
                                  const AlwaysStoppedAnimation<Color>(Colors.amber),
                            ),
                          ),
                        ),
                        const SizedBox(width: AppSpacing.xs),
                        SizedBox(
                          width: 18,
                          child: Text(
                            '${summary.distribution[stars] ?? 0}',
                            style: theme.textTheme.bodySmall,
                            textAlign: TextAlign.end,
                          ),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// Explains why there is no review form.
class _ReviewHintCard extends StatelessWidget {
  const _ReviewHintCard();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return AppCard(
      margin: EdgeInsets.zero,
      color: theme.colorScheme.surfaceContainerHighest,
      child: Row(
        children: [
          Icon(Icons.info_outline, color: theme.colorScheme.onSurfaceVariant),
          const SizedBox(width: AppSpacing.md),
          Expanded(
            child: Text(
              'You can review this room once the owner accepts your request.',
              style: theme.textTheme.bodyMedium,
            ),
          ),
        ],
      ),
    );
  }
}

/// The form to write a review.
class _WriteReviewCard extends ConsumerStatefulWidget {
  final String roomId;

  const _WriteReviewCard({required this.roomId});

  @override
  ConsumerState<_WriteReviewCard> createState() => _WriteReviewCardState();
}

class _WriteReviewCardState extends ConsumerState<_WriteReviewCard> {
  final _commentController = TextEditingController();
  int _rating = 0;
  bool _isSending = false;

  @override
  void initState() {
    super.initState();

    // The review the student already wrote is shown in the form — writing a
    // second one replaces it.
    ref.listenManual(myRoomReviewProvider(widget.roomId), (previous, next) {
      final review = next.valueOrNull;
      if (review == null) return;
      if (_rating != 0 && _rating != review.rating) return;
      if (_commentController.text.isNotEmpty &&
          _commentController.text != review.comment) {
        return;
      }
      if (!mounted) return;
      setState(() {
        _rating = review.rating;
        _commentController.text = review.comment;
      });
    });
  }

  @override
  void dispose() {
    _commentController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_rating < 1) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: const Text('Please choose a rating first'),
          backgroundColor: Theme.of(context).colorScheme.error,
        ),
      );
      return;
    }

    setState(() => _isSending = true);
    try {
      await ref.read(reviewRepositoryProvider).submitReview(
            roomId: widget.roomId,
            rating: _rating,
            comment: _commentController.text,
          );
      if (!mounted) return;

      ref.invalidate(roomReviewsProvider(widget.roomId));
      ref.invalidate(myRoomReviewProvider(widget.roomId));

      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Thank you — your review was published'),
          backgroundColor: Colors.green,
        ),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(e.toString().replaceFirst('Exception: ', '')),
          backgroundColor: Theme.of(context).colorScheme.error,
        ),
      );
    } finally {
      if (mounted) setState(() => _isSending = false);
    }
  }

  Future<void> _delete() async {
    final confirmed = await ConfirmationDialog.show(
      context,
      title: 'Remove your review?',
      message: 'Your review of this room will be deleted.',
      confirmLabel: 'Remove',
      isDestructive: true,
    );
    if (confirmed != true || !mounted) return;

    setState(() => _isSending = true);
    try {
      await ref.read(reviewRepositoryProvider).deleteReview(roomId: widget.roomId);
      if (!mounted) return;

      _commentController.clear();
      setState(() => _rating = 0);
      ref.invalidate(roomReviewsProvider(widget.roomId));
      ref.invalidate(myRoomReviewProvider(widget.roomId));
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(e.toString().replaceFirst('Exception: ', '')),
          backgroundColor: Theme.of(context).colorScheme.error,
        ),
      );
    } finally {
      if (mounted) setState(() => _isSending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final existing = ref.watch(myRoomReviewProvider(widget.roomId)).valueOrNull;

    return AppCard(
      margin: EdgeInsets.zero,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            existing == null ? 'Write a review' : 'Your review',
            style: theme.textTheme.titleMedium,
          ),
          const SizedBox(height: AppSpacing.md),
          Row(
            children: [
              for (var star = 1; star <= 5; star++)
                IconButton(
                  onPressed: _isSending
                      ? null
                      : () => setState(() => _rating = star),
                  icon: Icon(
                    star <= _rating ? Icons.star : Icons.star_border,
                    color: Colors.amber,
                    size: 30,
                  ),
                  tooltip: '$star star${star == 1 ? '' : 's'}',
                  padding: EdgeInsets.zero,
                  constraints: const BoxConstraints(),
                ),
            ],
          ),
          const SizedBox(height: AppSpacing.sm),
          TextField(
            controller: _commentController,
            enabled: !_isSending,
            maxLines: 3,
            maxLength: 500,
            decoration: const InputDecoration(
              labelText: 'Your experience (optional)',
              hintText: 'How was the room? How was the owner?',
            ),
          ),
          const SizedBox(height: AppSpacing.md),
          Row(
            children: [
              Expanded(
                child: AppButton(
                  label: existing == null ? 'Publish review' : 'Update review',
                  onPressed: _isSending ? null : _submit,
                  isFullWidth: true,
                ),
              ),
              if (existing != null) ...[
                const SizedBox(width: AppSpacing.sm),
                AppButton(
                  label: 'Remove',
                  onPressed: _isSending ? null : _delete,
                  isFullWidth: false,
                  type: ButtonType.danger,
                ),
              ],
            ],
          ),
        ],
      ),
    );
  }
}

/// One review.
class _ReviewCard extends StatelessWidget {
  final RoomReviewModel review;

  const _ReviewCard({required this.review});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return AppCard(
      margin: EdgeInsets.zero,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              AppAvatar(name: review.displayName, radius: 18),
              const SizedBox(width: AppSpacing.sm),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      review.displayName,
                      style: theme.textTheme.titleSmall,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    Text(
                      AppFormatters.formatRelativeTime(review.createdAt),
                      style: theme.textTheme.bodySmall,
                    ),
                  ],
                ),
              ),
              _Stars(rating: review.rating.toDouble(), size: 16),
            ],
          ),
          if (review.comment.trim().isNotEmpty) ...[
            const SizedBox(height: AppSpacing.md),
            Text(review.comment, style: theme.textTheme.bodyMedium),
          ],
        ],
      ),
    );
  }
}

/// A row of stars.
class _Stars extends StatelessWidget {
  final double rating;
  final double size;

  const _Stars({required this.rating, this.size = 16});

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (var star = 1; star <= 5; star++)
          Icon(
            rating >= star
                ? Icons.star
                : (rating >= star - 0.5 ? Icons.star_half : Icons.star_border),
            size: size,
            color: Colors.amber,
          ),
      ],
    );
  }
}

/// Opens the reviews of a room.
///
/// It is a small helper so that the button does not have to be built twice
/// (on the room itself and in the request list).
void openRoomReviews(BuildContext context, String roomId) {
  context.push('/room/$roomId/reviews');
}
