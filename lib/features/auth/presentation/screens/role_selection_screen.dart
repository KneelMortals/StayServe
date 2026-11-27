import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/index.dart';
import '../../../../models/user_model.dart';
import '../../../../../firebase/auth/auth_service.dart';
import '../../../../../firebase/otp/otp_service.dart';
import '../providers/auth_provider.dart';

/// Fallback screen for accounts that are signed in but have not completed
/// their StayServe role selection.
///
/// Firebase phone accounts and Google accounts already have a verified
/// contact. An email/password account still proves its address with the
/// existing StayServe email OTP. The profile and all verification flags are
/// written by the server.
class RoleSelectionScreen extends ConsumerStatefulWidget {
  const RoleSelectionScreen({super.key});

  @override
  ConsumerState<RoleSelectionScreen> createState() =>
      _RoleSelectionScreenState();
}

class _RoleSelectionScreenState extends ConsumerState<RoleSelectionScreen> {
  final _formKey = GlobalKey<FormState>();
  final _nameController = TextEditingController();

  UserRole? _selectedRole;
  bool _isLoading = false;

  @override
  void initState() {
    super.initState();
    // A Google account already knows the name of its owner. A phone account
    // does not, so the field stays empty and the user has to fill it in.
    final user = ref.read(authRepositoryProvider).currentUser;
    final displayName = user?.displayName?.trim() ?? '';
    if (displayName.isNotEmpty) {
      _nameController.text = displayName;
      return;
    }
    _prefillFromProfile(user?.uid);
  }

  /// Uses the name of the profile when Firebase Auth does not know one.
  ///
  /// A phone account has no name in Firebase Auth. The profile may still
  /// carry one — for example when the registration is repeated after a
  /// rollback. The placeholder of the bootstrap ("User") is not a name, so it
  /// is ignored.
  Future<void> _prefillFromProfile(String? uid) async {
    if (uid == null) return;
    final UserModel? profile;
    try {
      profile = await ref.read(userProfileProvider(uid).future);
    } catch (error) {
      return;
    }
    final name = profile?.name.trim() ?? '';
    if (name.isEmpty || name == 'User') return;
    if (!mounted || _nameController.text.isNotEmpty) return;
    _nameController.text = name;
  }

  @override
  void dispose() {
    _nameController.dispose();
    super.dispose();
  }

  Future<void> _continue() async {
    if (_selectedRole == null) return;
    if (!_formKey.currentState!.validate()) return;

    final authRepo = ref.read(authRepositoryProvider);
    final user = authRepo.currentUser;
    if (user == null) return;

    final email = user.email ?? '';

    setState(() => _isLoading = true);
    try {
      // A Firebase-verified Google/email identity already proves the
      // address. An email/password account still needs StayServe's one-time
      // email challenge. A phone-only account needs neither.
      var challenge = '';
      if (email.isNotEmpty && !user.emailVerified) {
        challenge = await _verifyEmail(email);
        if (challenge.isEmpty || !mounted) return;
      }

      if (!mounted) return;

      // The server writes the profile and re-checks the verification. It
      // returns the role which was actually stored; an already claimed role
      // is preserved by the server and may differ from the button which was
      // pressed.
      final name = _nameController.text.trim();
      final registration = await ref
          .read(otpServiceProvider)
          .completeRegistration(
            name: name,
            role: _selectedRole!.name,
            challenge: challenge,
          );
      final completedRole = registration.role;

      if (!mounted) return;

      // The Firestore snapshot may still contain the incomplete profile for a
      // short moment. Remember the server-confirmed role and registration
      // marker so the router does not bounce the user back here.
      ref
          .read(authProfileTransitionProvider.notifier)
          .state = AuthProfileTransition(
        uid: user.uid,
        registrationCompleted: true,
        phoneVerified: registration.phoneVerified,
        role: UserRoleX.fromString(completedRole),
      );

      if (!registration.phoneVerified) {
        // The account may be registered, but the student/owner service areas
        // stay closed until Firebase has verified a phone number.
        context.go('/verify-phone');
      } else if (completedRole == UserRole.owner.name) {
        context.go('/owner/dashboard');
      } else {
        context.go('/student/home');
      }
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(readableAuthError(e)),
          backgroundColor: Theme.of(context).colorScheme.error,
        ),
      );
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  /// Verifies the email address and returns the **challenge** of the
  /// verification — the proof that this device really entered the code.
  Future<String> _verifyEmail(String email) async {
    final challenge = await context.push<String>(
      Uri(
        path: '/verify-otp',
        queryParameters: {
          'channel': OtpChannel.email.name,
          'identifier': email,
        },
      ).toString(),
    );
    return challenge ?? '';
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final user = ref.watch(authRepositoryProvider).currentUser;

    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.xl),
          child: Form(
            key: _formKey,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const SizedBox(height: AppSpacing.xl),
                Center(
                  child: Column(
                    children: [
                      Container(
                        width: 80,
                        height: 80,
                        decoration: BoxDecoration(
                          color: theme.colorScheme.primaryContainer,
                          borderRadius: BorderRadius.circular(
                            AppBorderRadius.xl,
                          ),
                        ),
                        child: Icon(
                          Icons.home_outlined,
                          size: 40,
                          color: theme.colorScheme.primary,
                        ),
                      ),
                      const SizedBox(height: AppSpacing.lg),
                      Text(
                        'Complete Your Profile',
                        style: theme.textTheme.headlineMedium,
                      ),
                      const SizedBox(height: AppSpacing.sm),
                      Text(
                        'Tell us your name and select your role to personalize '
                        'your experience',
                        style: theme.textTheme.bodyMedium?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                        textAlign: TextAlign.center,
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: AppSpacing.xl),
                Text(
                  user?.emailVerified == true
                      ? 'Your email address is verified. Select a role to finish.'
                      : user?.phoneNumber?.trim().isNotEmpty == true
                      ? 'Your phone number is verified. Select a role to finish.'
                      : 'We will send a verification code to your email address '
                            'before finishing your profile.',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: AppSpacing.xl),
                AppTextField(
                  label: 'Full name',
                  hint: 'Your name',
                  controller: _nameController,
                  validator: AppValidators.validateName,
                  prefixIcon: const Icon(Icons.person_outline),
                  enabled: !_isLoading,
                  maxLength: AppValidators.maxNameLength,
                ),
                const SizedBox(height: AppSpacing.lg),
                Expanded(
                  child: Column(
                    children: [
                      Expanded(
                        child: _RoleSelectionCard(
                          role: UserRole.student,
                          title: 'Student',
                          subtitle: 'Looking for a room to rent',
                          description:
                              'Search rooms, contact owners, and manage your stay',
                          icon: Icons.school_outlined,
                          selected: _selectedRole == UserRole.student,
                          onTap: () =>
                              setState(() => _selectedRole = UserRole.student),
                        ),
                      ),
                      const SizedBox(height: AppSpacing.md),
                      Expanded(
                        child: _RoleSelectionCard(
                          role: UserRole.owner,
                          title: 'Room Owner',
                          subtitle: 'Have rooms to rent out',
                          description:
                              'List rooms, manage bookings, and earn income',
                          icon: Icons.apartment_outlined,
                          selected: _selectedRole == UserRole.owner,
                          onTap: () =>
                              setState(() => _selectedRole = UserRole.owner),
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: AppSpacing.lg),
                AppButton(
                  label: 'Continue',
                  onPressed: _selectedRole != null && !_isLoading
                      ? _continue
                      : null,
                  isLoading: _isLoading,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _RoleSelectionCard extends StatelessWidget {
  final UserRole role;
  final String title;
  final String subtitle;
  final String description;
  final IconData icon;
  final bool selected;
  final VoidCallback onTap;

  const _RoleSelectionCard({
    required this.role,
    required this.title,
    required this.subtitle,
    required this.description,
    required this.icon,
    required this.selected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(AppBorderRadius.xl),
      child: AnimatedContainer(
        duration: AppConstants.animationDuration,
        padding: const EdgeInsets.all(AppSpacing.lg),
        decoration: BoxDecoration(
          color: selected
              ? theme.colorScheme.primaryContainer
              : theme.colorScheme.surface,
          borderRadius: BorderRadius.circular(AppBorderRadius.xl),
          border: Border.all(
            color: selected
                ? theme.colorScheme.primary
                : theme.colorScheme.outlineVariant,
            width: selected ? 3 : 1,
          ),
          boxShadow: selected ? AppShadows.level2 : AppShadows.level1,
        ),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Container(
              padding: const EdgeInsets.all(AppSpacing.lg),
              decoration: BoxDecoration(
                color: selected
                    ? theme.colorScheme.primary
                    : theme.colorScheme.primaryContainer,
                shape: BoxShape.circle,
              ),
              child: Icon(
                icon,
                size: 40,
                color: selected
                    ? theme.colorScheme.onPrimary
                    : theme.colorScheme.primary,
              ),
            ),
            const SizedBox(height: AppSpacing.md),
            Text(
              title,
              style: theme.textTheme.headlineSmall?.copyWith(
                color: selected
                    ? theme.colorScheme.primary
                    : theme.colorScheme.onSurface,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: AppSpacing.xs),
            Text(
              subtitle,
              style: theme.textTheme.titleMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: AppSpacing.sm),
            Text(
              description,
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: AppSpacing.md),
            if (selected)
              Icon(
                Icons.check_circle,
                color: theme.colorScheme.primary,
                size: 28,
              ),
          ],
        ),
      ),
    );
  }
}
