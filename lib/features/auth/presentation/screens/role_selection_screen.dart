import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/index.dart';
import '../../../../../firebase/auth/auth_service.dart';
import '../../../../../firebase/otp/otp_service.dart';

/// Fallback screen for accounts that are signed in but have no profile yet.
///
/// Like the normal registration flow it insists on a verified email address
/// — the profile is written by the server, which re-checks the OTP
/// verification. The phone number is optional contact information.
class RoleSelectionScreen extends ConsumerStatefulWidget {
  const RoleSelectionScreen({super.key});

  @override
  ConsumerState<RoleSelectionScreen> createState() => _RoleSelectionScreenState();
}

class _RoleSelectionScreenState extends ConsumerState<RoleSelectionScreen> {
  final _formKey = GlobalKey<FormState>();
  final _phoneController = TextEditingController();

  UserRole? _selectedRole;
  bool _isLoading = false;

  @override
  void dispose() {
    _phoneController.dispose();
    super.dispose();
  }

  Future<void> _continue() async {
    if (_selectedRole == null) return;
    if (!_formKey.currentState!.validate()) return;

    final authRepo = ref.read(authRepositoryProvider);
    final user = authRepo.currentUser;
    if (user == null) return;

    final email = user.email ?? '';
    final phone = _phoneController.text.trim();

    setState(() => _isLoading = true);
    try {
      // The email address has to be verified as well.
      var challenge = '';
      if (email.isNotEmpty) {
        challenge = await _verifyEmail(email);
        if (challenge.isEmpty || !mounted) return;
      }

      if (!mounted) return;

      // The server writes the profile and re-checks the verification.
      await ref.read(otpServiceProvider).completeRegistration(
            name: user.displayName?.trim().isNotEmpty == true
                ? user.displayName!.trim()
                : 'User',
            phone: phone,
            role: _selectedRole!.name,
            challenge: challenge,
          );

      if (!mounted) return;

      if (_selectedRole == UserRole.owner) {
        context.go('/owner/dashboard');
      } else {
        context.go('/student/home');
      }
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(e.toString().replaceFirst('Exception: ', '')),
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
                          borderRadius: BorderRadius.circular(AppBorderRadius.xl),
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
                        'Select your role to personalize your experience',
                        style: theme.textTheme.bodyMedium?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                        textAlign: TextAlign.center,
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: AppSpacing.xl),
                AppTextField(
                  controller: _phoneController,
                  label: 'Phone Number (optional)',
                  hint: 'Enter your phone number',
                  keyboardType: TextInputType.phone,
                  textInputAction: TextInputAction.done,
                  validator: AppValidators.validatePhone,
                  prefixIcon: const Icon(Icons.phone_outlined),
                ),
                const SizedBox(height: AppSpacing.md),
                Text(
                  'We will send a verification code to your email address '
                  'before finishing your profile.',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: AppSpacing.xl),
                Expanded(
                  child: Column(
                    children: [
                      Expanded(
                        child: _RoleSelectionCard(
                          role: UserRole.student,
                          title: 'Student',
                          subtitle: 'Looking for a room to rent',
                          description: 'Search rooms, contact owners, and manage your stay',
                          icon: Icons.school_outlined,
                          selected: _selectedRole == UserRole.student,
                          onTap: () => setState(() => _selectedRole = UserRole.student),
                        ),
                      ),
                      const SizedBox(height: AppSpacing.md),
                      Expanded(
                        child: _RoleSelectionCard(
                          role: UserRole.owner,
                          title: 'Room Owner',
                          subtitle: 'Have rooms to rent out',
                          description: 'List rooms, manage bookings, and earn income',
                          icon: Icons.apartment_outlined,
                          selected: _selectedRole == UserRole.owner,
                          onTap: () => setState(() => _selectedRole = UserRole.owner),
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: AppSpacing.lg),
                AppButton(
                  label: 'Continue',
                  onPressed: _selectedRole != null && !_isLoading ? _continue : null,
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
          color: selected ? theme.colorScheme.primaryContainer : theme.colorScheme.surface,
          borderRadius: BorderRadius.circular(AppBorderRadius.xl),
          border: Border.all(
            color: selected ? theme.colorScheme.primary : theme.colorScheme.outlineVariant,
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
                color: selected ? theme.colorScheme.onPrimary : theme.colorScheme.primary,
              ),
            ),
            const SizedBox(height: AppSpacing.md),
            Text(
              title,
              style: theme.textTheme.headlineSmall?.copyWith(
                color: selected ? theme.colorScheme.primary : theme.colorScheme.onSurface,
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
