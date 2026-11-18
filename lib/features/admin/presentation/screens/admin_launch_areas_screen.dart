import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/index.dart';
import '../../../../models/launch_pincode_config.dart';
import '../providers/admin_providers.dart';
import '../widgets/admin_scaffold.dart';

class AdminLaunchAreasScreen extends ConsumerWidget {
  const AdminLaunchAreasScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final configAsync = ref.watch(adminLaunchPincodeConfigProvider);

    return AdminScaffold(
      title: 'Launch Areas',
      actions: [
        IconButton(
          icon: const Icon(Icons.refresh),
          tooltip: 'Reload',
          onPressed: () => ref.invalidate(adminLaunchPincodeConfigProvider),
        ),
      ],
      body: configAsync.when(
        data: (config) => _LaunchAreasContent(config: config),
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, stack) => Center(child: Text('Error: $error')),
      ),
    );
  }
}

class _LaunchAreasContent extends ConsumerStatefulWidget {
  final LaunchPincodeConfig config;

  const _LaunchAreasContent({required this.config});

  @override
  ConsumerState<_LaunchAreasContent> createState() => _LaunchAreasContentState();
}

class _LaunchAreasContentState extends ConsumerState<_LaunchAreasContent> {
  late TextEditingController _enabledController;
  late TextEditingController _disabledController;
  late String _selectedMode;

  @override
  void initState() {
    super.initState();
    _enabledController = TextEditingController(
      text: widget.config.enabledPincodes.join(', '),
    );
    _disabledController = TextEditingController(
      text: widget.config.disabledPincodes.join(', '),
    );
    _selectedMode = widget.config.mode;

    // The chips below are built from the text of the fields, so the screen
    // has to be rebuilt whenever the text changes.
    _enabledController.addListener(_onTextChanged);
    _disabledController.addListener(_onTextChanged);
  }

  void _onTextChanged() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    _enabledController.removeListener(_onTextChanged);
    _disabledController.removeListener(_onTextChanged);
    _enabledController.dispose();
    _disabledController.dispose();
    super.dispose();
  }

  /// The pincodes currently written in [controller].
  List<String> _pincodesOf(TextEditingController controller) {
    return controller.text
        .split(',')
        .map((e) => e.trim())
        .where((e) => e.isNotEmpty)
        .toList();
  }

  @override
  Widget build(BuildContext context) {
    final adminState = ref.watch(adminControllerProvider);

    return SingleChildScrollView(
      padding: const EdgeInsets.all(AppSpacing.md),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _buildModeSelector(context),
          const SizedBox(height: AppSpacing.lg),
          _buildEnabledPincodes(context),
          const SizedBox(height: AppSpacing.lg),
          _buildDisabledPincodes(context),
          const SizedBox(height: AppSpacing.lg),
          _buildInfoCard(context),
          const SizedBox(height: AppSpacing.lg),
          AppButton(
            label: 'Save Launch Areas',
            onPressed: adminState.isLoading ? null : _saveConfig,
            type: ButtonType.primary,
            isLoading: adminState.isLoading,
          ),
        ],
      ),
    );
  }

  Widget _buildModeSelector(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Launch Mode', style: theme.textTheme.titleLarge),
            const SizedBox(height: AppSpacing.md),
            Text(
              'Choose how pincode restrictions work',
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: AppSpacing.lg),
            // The button is in a horizontal scroll view: the two segments
            // with their icons did not fit on a narrow phone.
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: SegmentedButton<String>(
                showSelectedIcon: false,
                segments: const [
                  ButtonSegment(
                    value: 'whitelist',
                    label: Text('Whitelist'),
                    icon: Icon(Icons.check_circle_outline),
                  ),
                  ButtonSegment(
                    value: 'blacklist',
                    label: Text('Blacklist'),
                    icon: Icon(Icons.block_outlined),
                  ),
                ],
                selected: {_selectedMode},
                onSelectionChanged: (value) {
                  setState(() => _selectedMode = value.first);
                },
              ),
            ),
            const SizedBox(height: AppSpacing.md),
            Text(
              _selectedMode == 'whitelist'
                  ? 'Only users in ENABLED pincodes can access the app'
                  : 'Users in DISABLED pincodes are blocked from the app',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.primary,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildEnabledPincodes(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(
                  _selectedMode == 'whitelist' ? Icons.check_circle : Icons.block,
                  color: _selectedMode == 'whitelist' ? Colors.green : theme.colorScheme.onSurfaceVariant,
                ),
                const SizedBox(width: AppSpacing.sm),
                Expanded(
                  child: Text(
                    _selectedMode == 'whitelist' ? 'Enabled Pincodes (Whitelist)' : 'Enabled Pincodes (Ignored in Blacklist mode)',
                    style: theme.textTheme.titleLarge,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.md),
            TextField(
              controller: _enabledController,
              maxLines: 4,
              decoration: InputDecoration(
                hintText: 'Enter pincodes separated by commas\nExample: 110001, 110002, 400001',
                border: const OutlineInputBorder(),
                helperText: _selectedMode == 'whitelist'
                    ? 'Only these pincodes can access the app'
                    : 'Not used in Blacklist mode',
              ),
            ),
            if (_selectedMode == 'whitelist' && _pincodesOf(_enabledController).isNotEmpty) ...[
              const SizedBox(height: AppSpacing.md),
              Wrap(
                spacing: AppSpacing.sm,
                runSpacing: AppSpacing.sm,
                children: _pincodesOf(_enabledController)
                    .map((p) => Chip(
                          label: Text(p),
                          deleteIcon: const Icon(Icons.close, size: 16),
                          onDeleted: () => _removePincode(p, true),
                        ))
                    .toList(),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildDisabledPincodes(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(
                  _selectedMode == 'blacklist' ? Icons.block : Icons.check_circle,
                  color: _selectedMode == 'blacklist' ? Colors.red : theme.colorScheme.onSurfaceVariant,
                ),
                const SizedBox(width: AppSpacing.sm),
                Expanded(
                  child: Text(
                    _selectedMode == 'blacklist' ? 'Disabled Pincodes (Blacklist)' : 'Disabled Pincodes (Ignored in Whitelist mode)',
                    style: theme.textTheme.titleLarge,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.md),
            TextField(
              controller: _disabledController,
              maxLines: 4,
              decoration: InputDecoration(
                hintText: 'Enter pincodes separated by commas\nExample: 560001, 560002',
                border: const OutlineInputBorder(),
                helperText: _selectedMode == 'blacklist'
                    ? 'Users in these pincodes are blocked'
                    : 'Not used in Whitelist mode',
              ),
            ),
            if (_selectedMode == 'blacklist' && _pincodesOf(_disabledController).isNotEmpty) ...[
              const SizedBox(height: AppSpacing.md),
              Wrap(
                spacing: AppSpacing.sm,
                runSpacing: AppSpacing.sm,
                children: _pincodesOf(_disabledController)
                    .map((p) => Chip(
                          label: Text(p),
                          deleteIcon: const Icon(Icons.close, size: 16),
                          onDeleted: () => _removePincode(p, false),
                        ))
                    .toList(),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildInfoCard(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      color: theme.colorScheme.primaryContainer,
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(Icons.info_outline, color: theme.colorScheme.onPrimaryContainer),
                const SizedBox(width: AppSpacing.sm),
                Expanded(
                  child: Text(
                    'How it works',
                    style: theme.textTheme.titleMedium?.copyWith(
                      color: theme.colorScheme.onPrimaryContainer,
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.md),
            Text(
              '• The pincode is checked on every app start, before and after '
              'signing in\n'
              '• Whitelist: Only the listed pincodes can use the app\n'
              '• Blacklist: Every pincode works except the listed ones\n'
              '• Until you save a configuration the app runs everywhere\n'
              '• An empty whitelist closes the app down completely',
              style: theme.textTheme.bodyMedium?.copyWith(color: theme.colorScheme.onPrimaryContainer),
            ),
          ],
        ),
      ),
    );
  }

  void _removePincode(String pincode, bool isEnabled) {
    setState(() {
      if (isEnabled) {
        final list = _enabledController.text
            .split(',')
            .map((e) => e.trim())
            .where((e) => e.isNotEmpty && e != pincode)
            .toList();
        _enabledController.text = list.join(', ');
      } else {
        final list = _disabledController.text
            .split(',')
            .map((e) => e.trim())
            .where((e) => e.isNotEmpty && e != pincode)
            .toList();
        _disabledController.text = list.join(', ');
      }
    });
  }

  Future<void> _saveConfig() async {
    final enabled = _pincodesOf(_enabledController);
    final disabled = _pincodesOf(_disabledController);

    final error = await ref
        .read(adminControllerProvider.notifier)
        .updateLaunchPincodeConfig(
          enabledPincodes: enabled,
          disabledPincodes: disabled,
          mode: _selectedMode,
        );
    if (!mounted) return;
    if (context.showErrorIfAny(error)) return;
    context.showSuccessSnackBar('Launch areas saved');
  }
}