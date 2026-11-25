import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/index.dart';
import '../../../../features/auth/presentation/providers/auth_provider.dart';

class StudentProfileScreen extends ConsumerWidget {
  const StudentProfileScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // The live session profile is used here instead of the one-shot
    // `userProfileProvider`. Firebase phone/Google linking and a later
    // verified-email link update the streamed Firestore document; a cached
    // future would keep showing the old contact details.
    final session = ref.watch(authSessionProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('Profile')),
      body: session.when(
        data: (session) {
          if (session?.user == null) {
            return const Center(child: Text('Not logged in'));
          }
          final profile = session!.profile;
          if (profile == null) {
            return const Center(child: Text('Profile not found'));
          }
          return SingleChildScrollView(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Center(
                  child: Column(
                    children: [
                      CircleAvatar(
                        radius: 50,
                        backgroundColor: Theme.of(
                          context,
                        ).colorScheme.primary.withValues(alpha: 0.1),
                        backgroundImage:
                            profile.profileImage != null &&
                                profile.profileImage!.isNotEmpty
                            ? NetworkImage(profile.profileImage!)
                            : null,
                        child:
                            profile.profileImage == null ||
                                profile.profileImage!.isEmpty
                            ? Text(
                                // `profile.name[0]` threw a `RangeError`
                                // for a user whose name was empty.
                                profile.initials,
                                style: TextStyle(
                                  fontSize: 32,
                                  color: Theme.of(context).colorScheme.primary,
                                ),
                              )
                            : null,
                      ),
                      const SizedBox(height: 16),
                      Text(
                        profile.name,
                        style: Theme.of(context).textTheme.headlineSmall
                            ?.copyWith(fontWeight: FontWeight.bold),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        profile.email,
                        style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                          color: Theme.of(context).colorScheme.onSurfaceVariant,
                        ),
                      ),
                      const SizedBox(height: 8),
                      Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 12,
                          vertical: 4,
                        ),
                        decoration: BoxDecoration(
                          color: Theme.of(
                            context,
                          ).colorScheme.primary.withValues(alpha: 0.1),
                          borderRadius: BorderRadius.circular(12),
                        ),
                        child: Text(
                          profile.role.displayName,
                          style: TextStyle(
                            color: Theme.of(context).colorScheme.primary,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 32),
                Text(
                  'Personal Information',
                  style: Theme.of(
                    context,
                  ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.bold),
                ),
                const SizedBox(height: 16),
                _InfoTile(
                  icon: Icons.person_outline,
                  label: 'Name',
                  value: profile.name,
                ),
                _InfoTile(
                  icon: Icons.email_outlined,
                  label: 'Email',
                  value: profile.email,
                ),
                _InfoTile(
                  icon: Icons.phone_outlined,
                  label: 'Phone',
                  value: profile.phone ?? 'Not provided',
                ),
                _InfoTile(
                  icon: Icons.location_on_outlined,
                  label: 'Role',
                  value: profile.role.displayName,
                ),
                if (profile.pincode != null && profile.pincode!.isNotEmpty)
                  _InfoTile(
                    icon: Icons.pin_drop_outlined,
                    label: 'Your area',
                    value: profile.pincode!,
                  ),
                const SizedBox(height: 24),
                Card(
                  margin: EdgeInsets.zero,
                  child: Column(children: const [ThemeModeSwitch()]),
                ),
                const SizedBox(height: 16),
                AppButton(
                  label: 'Edit Profile',
                  onPressed: () {
                    // The route `/student/profile/edit` did not exist —
                    // the router showed its "Page Not Found" page. It is
                    // registered now.
                    context.push('/student/profile/edit');
                  },
                  type: ButtonType.secondary,
                ),
                const SizedBox(height: 12),
                AppButton(
                  label: 'Logout',
                  onPressed: () => signOutAndGoToLogin(context, ref),
                  type: ButtonType.danger,
                ),
              ],
            ),
          );
        },
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, stack) => Center(child: Text('Error: $error')),
      ),
    );
  }
}

class _InfoTile extends StatelessWidget {
  final IconData icon;
  final String label;
  final String value;

  const _InfoTile({
    required this.icon,
    required this.label,
    required this.value,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Row(
        children: [
          Icon(icon, color: theme.colorScheme.onSurfaceVariant, size: 24),
          const SizedBox(width: 16),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  label,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
                Text(
                  value,
                  style: theme.textTheme.bodyMedium?.copyWith(
                    fontWeight: FontWeight.w500,
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
