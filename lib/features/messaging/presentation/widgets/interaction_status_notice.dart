import 'package:material_ui/material_ui.dart';

/// Shows that the server-owned participant/block status is not ready yet.
///
/// The interaction details contain the current personal-block state. The UI
/// must fail closed while they are loading or unavailable: the server will
/// reject a protected action anyway, and showing an enabled button would
/// only invite the user into an error.
class InteractionStatusNotice extends StatelessWidget {
  final bool isLoading;
  final VoidCallback onRetry;

  const InteractionStatusNotice({
    required this.isLoading,
    required this.onRetry,
    super.key,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isError = !isLoading;

    return Container(
      width: double.infinity,
      color: isError
          ? theme.colorScheme.errorContainer
          : theme.colorScheme.surfaceContainerHighest,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      child: Row(
        children: [
          if (isLoading)
            const SizedBox(
              width: 20,
              height: 20,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          else
            Icon(
              Icons.warning_amber,
              color: theme.colorScheme.onErrorContainer,
            ),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              isLoading
                  ? 'Checking participant status…'
                  : 'Could not verify the participant status. New messages and '
                        'booking progression are paused.',
              style: theme.textTheme.bodySmall?.copyWith(
                color: isError ? theme.colorScheme.onErrorContainer : null,
              ),
            ),
          ),
          if (isError)
            TextButton(onPressed: onRetry, child: const Text('Retry')),
        ],
      ),
    );
  }
}
