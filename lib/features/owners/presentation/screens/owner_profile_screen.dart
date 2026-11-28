import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/index.dart';
import '../../../../models/user_model.dart';
import '../../../../features/auth/presentation/providers/auth_provider.dart';

class OwnerProfileScreen extends ConsumerWidget {
  const OwnerProfileScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(authSessionProvider).valueOrNull;
    final profile = session?.profile;

    return Scaffold(
      appBar: AppBar(title: const Text('Profile')),
      body: ListView(
        padding: const EdgeInsets.all(AppSpacing.md),
        children: [
          _buildHeader(context, profile),
          const SizedBox(height: AppSpacing.xl),
          _buildSection(context, 'Account', [
            _ProfileTile(
              icon: Icons.person_outline,
              title: 'Edit Profile',
              subtitle: profile?.name ?? '',
              // The old tile was an empty `onTap: () {}` — it looked
              // clickable but did nothing at all.
              onTap: () => context.push('/owner/profile/edit'),
            ),
            _ProfileTile(
              icon: Icons.lock_outline,
              title: 'Change Password',
              subtitle: 'We send you a reset link by email',
              // A phone-only account has no password to change. The old tile
              // opened the reset screen, which the router sent straight back
              // to the dashboard — a dead end without an explanation.
              onTap: () {
                final email = profile?.email ?? '';
                if (email.isEmpty) {
                  _showInfo(
                    context,
                    title: 'No password to change',
                    message:
                        'This account signs in with your phone number, so it '
                        'has no password. Add an email address in "Edit '
                        'Profile" if you want to use a password as well.',
                  );
                  return;
                }
                context.push('/forgot-password');
              },
            ),
            _ProfileTile(
              icon: Icons.account_balance_outlined,
              title: 'Platform fee',
              subtitle:
                  '${AppConstants.platformFeePercentage.toStringAsFixed(0)}% — paid once, on the first payment',
              onTap: () => _showPlatformFee(context),
            ),
          ]),
          _buildSection(context, 'Settings', [
            const ThemeModeSwitch(),
            const Divider(height: 1),
            _ProfileTile(
              icon: Icons.notifications_outlined,
              title: 'Notifications',
              subtitle: 'See what happened to your listings',
              // `/notifications` is a root-level route. Use `go` so the
              // nested owner shell does not try to render it as a child
              // route (which produced a blank page).
              onTap: () => context.go('/notifications'),
            ),
            _ProfileTile(
              icon: Icons.help_outline,
              title: 'Help & Support',
              subtitle: 'Get in touch with the StayServe team',
              onTap: () => _showInfo(
                context,
                title: 'Help & Support',
                message:
                    'Need a hand? Write to us at '
                    '${AppConstants.supportEmail} and we will get back to you '
                    'within one working day.',
              ),
            ),
            _ProfileTile(
              icon: Icons.privacy_tip_outlined,
              title: 'Privacy Policy',
              subtitle: 'How we handle your data',
              onTap: () => _showInfo(
                context,
                title: 'Privacy Policy',
                message:
                    'StayServe only stores the data you give us: your name, '
                    'email address, optional phone number, your listings and '
                    'the requests you send. Your data is never sold, and '
                    'deleting your account removes it permanently.',
              ),
            ),
            _ProfileTile(
              icon: Icons.description_outlined,
              title: 'Terms of Service',
              subtitle: 'The rules of using StayServe',
              onTap: () => _showInfo(
                context,
                title: 'Terms of Service',
                message:
                    'Listings must be genuine and the rent must match what '
                    'you publish. Platform fees are charged only after a '
                    'student joins a room, and a booking is confirmed once '
                    'the payment has been verified.',
              ),
            ),
          ]),
          const SizedBox(height: AppSpacing.lg),
          AppButton(
            label: 'Logout',
            onPressed: () => signOutAndGoToLogin(context, ref),
            type: ButtonType.danger,
          ),
        ],
      ),
    );
  }

  Widget _buildHeader(BuildContext context, UserModel? profile) {
    final theme = Theme.of(context);
    final name = profile?.name ?? '';
    final email = profile?.email ?? '';
    final phone = profile?.phone ?? '';
    // A phone-only account has no address. It is nevertheless signed in, so
    // the header names the way it signed in instead of claiming that nobody
    // is signed in.
    final subtitle = email.isNotEmpty
        ? email
        : phone.isNotEmpty
        ? 'Signed in with your phone number'
        : 'Signed in';

    return Center(
      child: Column(
        children: [
          AppAvatar(
            name: name.isEmpty ? null : name,
            imageUrl: profile?.profileImage,
            radius: 50,
          ),
          const SizedBox(height: AppSpacing.md),
          Text(
            name.isEmpty ? 'Owner' : name,
            style: theme.textTheme.headlineSmall?.copyWith(
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: AppSpacing.xs),
          Text(
            subtitle,
            style: theme.textTheme.bodyMedium?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
          if (profile != null &&
              profile.phone != null &&
              profile.phone!.isNotEmpty) ...[
            const SizedBox(height: AppSpacing.xs),
            Text(
              profile.phone!,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildSection(
    BuildContext context,
    String title,
    List<Widget> children,
  ) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          title,
          style: theme.textTheme.labelLarge?.copyWith(
            color: theme.colorScheme.primary,
          ),
        ),
        const SizedBox(height: AppSpacing.sm),
        Card(child: Column(children: children)),
        const SizedBox(height: AppSpacing.lg),
      ],
    );
  }

  /// Explains how the platform fee works.
  ///
  /// The owner never has to upload a UPI: the platform fee is paid to the
  /// StayServe UPI, and it is charged **once** — on the first payment of a
  /// booking. Every later payment goes straight from the student to the
  /// owner.
  void _showPlatformFee(BuildContext context) {
    showDialog(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Platform fee'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'StayServe charges a '
                '${AppConstants.platformFeePercentage.toStringAsFixed(0)}% '
                'platform fee. It is taken **once** — on the first payment of '
                'a booking. From the second payment on, the rent is settled '
                'directly between you and the student.',
              ),
              const SizedBox(height: AppSpacing.md),
              const Text('Our UPI'),
              SelectableText(AppConstants.platformUpiVpa),
              const SizedBox(height: AppSpacing.xs),
              Text(
                'You do not have to upload your own UPI id — the fee is '
                'settled on this address.',
                style: Theme.of(dialogContext).textTheme.bodySmall,
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext),
            child: const Text('Close'),
          ),
        ],
      ),
    );
  }

  /// Shows a short piece of information (privacy policy, terms, support).
  void _showInfo(
    BuildContext context, {
    required String title,
    required String message,
  }) {
    showDialog(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(title),
        // The text is **not** wrapped in a scroll view: a scroll view hides
        // the words from the screen reader, so the message would be read as
        // an empty box.
        content: Text(message),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext),
            child: const Text('Close'),
          ),
        ],
      ),
    );
  }
}

class _ProfileTile extends StatelessWidget {
  final IconData icon;
  final String title;
  final String? subtitle;
  final VoidCallback onTap;

  const _ProfileTile({
    required this.icon,
    required this.title,
    this.subtitle,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return ListTile(
      leading: Icon(icon),
      title: Text(title),
      subtitle: subtitle == null || subtitle!.isEmpty ? null : Text(subtitle!),
      trailing: const Icon(Icons.chevron_right),
      onTap: onTap,
    );
  }
}
