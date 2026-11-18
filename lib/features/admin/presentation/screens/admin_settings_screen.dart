import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/index.dart';
import '../providers/admin_providers.dart';
import '../widgets/admin_scaffold.dart';

class AdminSettingsScreen extends ConsumerStatefulWidget {
  const AdminSettingsScreen({super.key});

  @override
  ConsumerState<AdminSettingsScreen> createState() => _AdminSettingsScreenState();
}

class _AdminSettingsScreenState extends ConsumerState<AdminSettingsScreen> {
  /// The percentage the admin has **chosen** with the slider.
  ///
  /// It is kept here and not inside the slider widget: the "Save" button
  /// has to save the value that was chosen.
  ///
  /// Before the fix the slider kept its value in its own state and the
  /// save button read the value that was loaded from Firestore — so moving
  /// the slider and tapping "Save Commission Settings" saved the **old**
  /// value. The admin saw "Commission saved", the slider showed the new
  /// value and the setting never changed.
  ///
  /// `null` means "nothing was chosen yet" — the value from the database is
  /// used then.
  double? _chosenCommission;

  @override
  Widget build(BuildContext context) {
    final commissionAsync = ref.watch(adminCommissionPercentageProvider);
    final maintenanceAsync = ref.watch(adminMaintenanceModeProvider);
    final notificationsAsync = ref.watch(adminNotificationsEnabledProvider);
    final feePayerAsync = ref.watch(adminFeePayerProvider);

    return AdminScaffold(
      title: 'Settings',
      body: ListView(
        padding: const EdgeInsets.all(AppSpacing.md),
        children: [
          _buildAppearanceSection(context),
          const SizedBox(height: AppSpacing.lg),
          _buildCommissionSection(context, ref, commissionAsync),
          const SizedBox(height: AppSpacing.lg),
          _buildFeePayerSection(context, ref, feePayerAsync),
          const SizedBox(height: AppSpacing.lg),
          _buildPlatformSection(context, ref, maintenanceAsync, notificationsAsync),
          const SizedBox(height: AppSpacing.lg),
          _buildMaintenanceSection(context, ref),
        ],
      ),
    );
  }

  /// The heading of a card.
  ///
  /// The heading is an `Icon` next to a `Text` — in a `Row` the long
  /// headings ("Who pays the platform fee?") did not fit on a narrow
  /// phone and ran into the icon.
  Widget _buildHeading(BuildContext context, IconData icon, String title) {
    final theme = Theme.of(context);
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, color: theme.colorScheme.primary),
        const SizedBox(width: AppSpacing.sm),
        Expanded(
          child: Text(
            title,
            style: theme.textTheme.titleLarge,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
          ),
        ),
      ],
    );
  }

  /// The light/dark switch of the app.
  Widget _buildAppearanceSection(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _buildHeading(context, Icons.palette_outlined, 'Appearance'),
            const SizedBox(height: AppSpacing.md),
            const ThemeModeSwitch(),
          ],
        ),
      ),
    );
  }

  Widget _buildCommissionSection(BuildContext context, WidgetRef ref, AsyncValue<double> commissionAsync) {
    final theme = Theme.of(context);

    // The value that is really in the database.
    final saved = commissionAsync.valueOrNull ?? 30.0;
    // The value the admin sees — the one they chose, or the saved one.
    final current = _chosenCommission ?? saved;

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _buildHeading(context, Icons.percent, 'Commission Settings'),
            const SizedBox(height: AppSpacing.md),
            Text(
              'Set the commission percentage charged to owners when a student successfully joins a room.',
              style: theme.textTheme.bodyMedium?.copyWith(color: theme.colorScheme.onSurfaceVariant),
            ),
            const SizedBox(height: AppSpacing.lg),
            commissionAsync.when(
              data: (commission) => _CommissionSlider(
                value: current,
                onChanged: (value) => setState(() => _chosenCommission = value),
              ),
              loading: () => _CommissionSlider(
                value: current,
                onChanged: (value) => setState(() => _chosenCommission = value),
              ),
              error: (_, _) => _CommissionSlider(
                value: current,
                onChanged: (value) => setState(() => _chosenCommission = value),
              ),
            ),
            const SizedBox(height: AppSpacing.lg),
            _buildCommissionExamples(context, current),
            const SizedBox(height: AppSpacing.lg),
            AppButton(
              label: 'Save Commission Settings',
              onPressed: () async {
                // The value the admin has **chosen** — not the value that
                // happened to be in the database when the screen was opened.
                final commission = current;
                final error = await ref
                    .read(adminControllerProvider.notifier)
                    .updateCommissionPercentage(commission);
                if (!context.mounted) return;
                if (context.showErrorIfAny(error)) return;
                // The value is now the one in the database — the slider
                // follows it again from now on.
                setState(() => _chosenCommission = null);
                context.showSuccessSnackBar('Commission saved');
              },
              type: ButtonType.primary,
            ),
          ],
        ),
      ),
    );
  }

  /// Who settles the platform fee.
  ///
  /// The cut is taken **once**, on the first payment of a booking. When the
  /// owner pays it, the owner is notified when a student books a room and
  /// settles the fee on the platform's own UPI — the owner never has to
  /// upload a UPI of their own. When the student pays it, the student pays
  /// the fee when they confirm the booking.
  Widget _buildFeePayerSection(
    BuildContext context,
    WidgetRef ref,
    AsyncValue<String> feePayerAsync,
  ) {
    final theme = Theme.of(context);
    final payer = feePayerAsync.valueOrNull ?? 'owner';

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _buildHeading(
              context,
              Icons.payments_outlined,
              'Who pays the platform fee?',
            ),
            const SizedBox(height: AppSpacing.md),
            Text(
              'The platform fee is taken only once — on the first payment of a '
              'booking. After that the rent is settled directly between the '
              'student and the room owner.',
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: AppSpacing.md),
            // The button is in a horizontal scroll view: the two segments
            // with their icons did not fit on a narrow phone and the
            // right one was cut off.
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: SegmentedButton<String>(
                showSelectedIcon: false,
                segments: const [
                  ButtonSegment(
                    value: 'owner',
                    label: Text('Room owner'),
                    icon: Icon(Icons.home_outlined),
                  ),
                  ButtonSegment(
                    value: 'student',
                    label: Text('Student'),
                    icon: Icon(Icons.person_outline),
                  ),
                ],
                selected: {payer},
                onSelectionChanged: (selection) async {
                  final value = selection.first;
                  final error = await ref
                      .read(adminControllerProvider.notifier)
                      .setFeePayer(value);
                  if (!context.mounted) return;
                  if (context.showErrorIfAny(error)) return;
                  context.showSuccessSnackBar(
                    value == 'owner'
                        ? 'The room owner now pays the platform fee.'
                        : 'The student now pays the platform fee.',
                  );
                },
              ),
            ),
            const SizedBox(height: AppSpacing.sm),
            Text(
              payer == 'owner'
                  ? 'The room owner is notified when a student books a room '
                      'and pays the fee to ${AppConstants.platformUpiVpa}. '
                      'No UPI has to be uploaded by the owner.'
                  : 'The student pays the fee to ${AppConstants.platformUpiVpa} '
                      'when they confirm the booking.',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildPlatformSection(
    BuildContext context,
    WidgetRef ref,
    AsyncValue<bool> maintenanceAsync,
    AsyncValue<bool> notificationsAsync,
  ) {
    final theme = Theme.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Platform Settings', style: theme.textTheme.titleLarge),
            const SizedBox(height: AppSpacing.md),
            maintenanceAsync.when(
              data: (maintenance) => SwitchListTile(
                title: const Text('Maintenance Mode'),
                subtitle: const Text('Disable new bookings and show maintenance message'),
                value: maintenance,
                onChanged: (value) async {
                  final error = await ref
                      .read(adminControllerProvider.notifier)
                      .setMaintenanceMode(value);
                  if (!context.mounted) return;
                  if (context.showErrorIfAny(error)) return;
                  context.showSuccessSnackBar(
                    value ? 'Maintenance mode is on' : 'Maintenance mode is off',
                  );
                },
              ),
              loading: () => SwitchListTile(
                title: const Text('Maintenance Mode'),
                subtitle: const Text('Loading...'),
                value: false,
                onChanged: null,
              ),
              error: (_, _) => SwitchListTile(
                title: const Text('Maintenance Mode'),
                subtitle: const Text('Error loading setting'),
                value: false,
                onChanged: null,
              ),
            ),
            notificationsAsync.when(
              data: (enabled) => SwitchListTile(
                title: const Text('Enable Notifications'),
                subtitle: const Text('Send in-app notifications for important events'),
                value: enabled,
                onChanged: (value) async {
                  final error = await ref
                      .read(adminControllerProvider.notifier)
                      .setNotificationsEnabled(value);
                  if (!context.mounted) return;
                  if (context.showErrorIfAny(error)) return;
                  context.showSuccessSnackBar(
                    value ? 'Notifications are on' : 'Notifications are off',
                  );
                },
              ),
              loading: () => SwitchListTile(
                title: const Text('Enable Notifications'),
                subtitle: const Text('Loading...'),
                value: false,
                onChanged: null,
              ),
              error: (_, _) => SwitchListTile(
                title: const Text('Enable Notifications'),
                subtitle: const Text('Error loading setting'),
                value: false,
                onChanged: null,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildMaintenanceSection(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('System Actions', style: theme.textTheme.titleLarge),
            const SizedBox(height: AppSpacing.md),
            // The button is **below** the text and not in the trailing slot
            // of the list tile: with the icon, the title, the subtitle and
            // the button in one row nothing fit on a narrow phone.
            _MaintenanceAction(
              icon: Icons.cleaning_services,
              color: theme.colorScheme.error,
              title: 'Clear Old Notifications',
              subtitle: 'Remove notifications older than 30 days',
              onRun: () => _runTask(context, ref, 'cleanNotifications'),
            ),
            const Divider(height: AppSpacing.lg),
            _MaintenanceAction(
              icon: Icons.archive,
              color: theme.colorScheme.tertiary,
              title: 'Archive Inactive Rooms',
              subtitle: 'Archive rooms inactive for 90+ days',
              onRun: () => _runTask(context, ref, 'archiveRooms'),
            ),
          ],
        ),
      ),
    );
  }

  /// Runs one of the maintenance tasks on the server.
  ///
  /// The buttons used to be empty `onPressed: () {}` handlers — they looked
  /// like they worked but did nothing at all.
  Future<void> _runTask(BuildContext context, WidgetRef ref, String task) async {
    final error = await ref
        .read(adminControllerProvider.notifier)
        .runMaintenanceTask(task);
    if (!context.mounted) return;
    if (context.showErrorIfAny(error)) return;
    context.showSuccessSnackBar('Done');
  }

  Widget _buildCommissionExamples(BuildContext context, double commissionPercent) {
    final theme = Theme.of(context);
    final percent = commissionPercent.toInt();
    final rents = [5000, 10000, 15000, 20000, 25000];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Commission Examples (at $percent%):', style: theme.textTheme.labelLarge),
        const SizedBox(height: AppSpacing.sm),
        Wrap(
          spacing: AppSpacing.md,
          runSpacing: AppSpacing.sm,
          children: rents.map((rent) {
            final commission = rent * percent / 100;
            return Container(
              padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md, vertical: AppSpacing.sm),
              decoration: BoxDecoration(
                color: theme.colorScheme.surfaceContainerHighest,
                borderRadius: BorderRadius.circular(AppBorderRadius.md),
              ),
              child: Text(
                '₹${_formatNumber(rent)} → ₹${_formatNumber(commission.toInt())}',
                style: theme.textTheme.labelMedium,
              ),
            );
          }).toList(),
        ),
      ],
    );
  }

  String _formatNumber(int number) {
    if (number >= 100000) {
      return '${(number / 100000).toStringAsFixed(1)}L';
    } else if (number >= 1000) {
      return '${(number / 1000).toStringAsFixed(1)}K';
    }
    return number.toString();
  }
}

/// One of the server-side maintenance actions.
///
/// The button is below the text — in the trailing slot of a list tile
/// there was no room for it on a narrow phone.
class _MaintenanceAction extends StatelessWidget {
  final IconData icon;
  final Color color;
  final String title;
  final String subtitle;
  final VoidCallback onRun;

  const _MaintenanceAction({
    required this.icon,
    required this.color,
    required this.title,
    required this.subtitle,
    required this.onRun,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(icon, color: color),
            const SizedBox(width: AppSpacing.md),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    style: theme.textTheme.titleSmall,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  Text(
                    subtitle,
                    style: theme.textTheme.bodySmall,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
                ],
              ),
            ),
          ],
        ),
        const SizedBox(height: AppSpacing.sm),
        Align(
          alignment: Alignment.centerLeft,
          child: AppButton(
            label: 'Run',
            onPressed: onRun,
            isFullWidth: false,
            type: ButtonType.secondary,
          ),
        ),
      ],
    );
  }
}

/// The slider of the commission percentage.
///
/// The slider is **fully controlled**: the value lives in the screen above
/// it and every change is reported through [onChanged]. It used to keep the
/// value in its own state — and the save button, which lives in the screen
/// above, could not read it. Moving the slider and saving therefore changed
/// nothing.
class _CommissionSlider extends StatelessWidget {
  final double value;
  final ValueChanged<double> onChanged;

  const _CommissionSlider({required this.value, required this.onChanged});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            Expanded(
              child: Text(
                'Commission Percentage',
                style: theme.textTheme.titleMedium,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
            const SizedBox(width: AppSpacing.sm),
            Text(
              '${value.toInt()}%',
              style: theme.textTheme.headlineSmall?.copyWith(
                color: theme.colorScheme.primary,
                fontWeight: FontWeight.w700,
              ),
            ),
          ],
        ),
        Slider(
          value: value,
          min: 0,
          max: 30,
          divisions: 30,
          label: '${value.toInt()}%',
          onChanged: onChanged,
        ),
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text('0%', style: theme.textTheme.bodySmall),
            Text('30% (Max)', style: theme.textTheme.bodySmall),
          ],
        ),
      ],
    );
  }
}
