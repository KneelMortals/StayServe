import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/index.dart';
import '../../../../../firebase/otp/otp_service.dart';
import '../providers/auth_provider.dart';

class RegisterScreen extends ConsumerStatefulWidget {
  const RegisterScreen({super.key});

  @override
  ConsumerState<RegisterScreen> createState() => _RegisterScreenState();
}

class _RegisterScreenState extends ConsumerState<RegisterScreen> {
  final _formKey = GlobalKey<FormState>();
  final _nameController = TextEditingController();
  final _emailController = TextEditingController();
  final _passwordController = TextEditingController();
  final _confirmPasswordController = TextEditingController();
  bool _obscurePassword = true;
  bool _obscureConfirmPassword = true;
  UserRole _selectedRole = UserRole.student;
  bool _emailVerified = false;

  /// The challenge of the email verification.
  ///
  /// It is the proof that *this* device really entered the code — the
  /// server asks for it when the registration is completed.
  String _emailChallenge = '';

  @override
  void dispose() {
    _nameController.dispose();
    _emailController.dispose();
    _passwordController.dispose();
    _confirmPasswordController.dispose();
    super.dispose();
  }

  Future<void> _handleRegister() async {
    if (!_formKey.currentState!.validate()) return;

    // The email address has to be verified before an account can be created.
    // The server enforces this again in `completeRegistration`.
    if (!_emailVerified) {
      final verified = await _verifyEmail();
      if (!verified || !mounted) return;
    }

    if (!mounted) return;

    final registration = await ref
        .read(authControllerProvider.notifier)
        .signUp(
          email: _emailController.text.trim(),
          password: _passwordController.text,
          name: _nameController.text.trim(),
          role: _selectedRole,
          challenge: _emailChallenge,
        );

    if (!mounted) return;

    final error = ref.read(authControllerProvider).error;
    if (error == null && registration != null) {
      // The server already wrote the profile and attached the role claim
      // during `completeRegistration`. Route with the role and phone state
      // which the server confirmed, rather than waiting for a possibly stale
      // Firestore snapshot.
      AppLogger.info(
        'Registration completed for ${AppHelpers.maskEmail(_emailController.text.trim())}',
      );
      if (!registration.phoneVerified) {
        context.go('/verify-phone');
      } else if (registration.role == UserRole.owner.name) {
        context.go('/owner/dashboard');
      } else {
        context.go('/student/home');
      }
      return;
    }

    // The server may consume or reject the one-time verification challenge.
    // A failed registration must never leave the screen in a state where a
    // later attempt silently reuses that challenge. The user has to verify
    // the address again before another registration can be attempted.
    _invalidateEmailVerification();
  }

  Future<void> _continueWithGoogle() async {
    await ref.read(authControllerProvider.notifier).signInWithGoogle();
    if (!mounted) return;
    if (ref.read(authControllerProvider).error == null) {
      context.go('/role-selection');
    }
  }

  void _continueWithPhone() {
    context.go('/phone-auth');
  }

  Future<bool> _verifyEmail() async {
    final identifier = _emailController.text.trim();

    if (identifier.isEmpty) {
      _showError('Enter your email address first');
      return false;
    }

    // The screen answers with the **challenge** of the verification — the
    // proof that this device really entered the code.
    final challenge = await context.push<String>(
      Uri(
        path: '/verify-otp',
        queryParameters: {
          'channel': OtpChannel.email.name,
          'identifier': identifier,
        },
      ).toString(),
    );

    if (challenge != null && challenge.isNotEmpty && mounted) {
      setState(() {
        _emailVerified = true;
        _emailChallenge = challenge;
      });
      return true;
    }
    return false;
  }

  void _showError(String message) {
    final theme = Theme.of(context);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(message),
        backgroundColor: theme.colorScheme.error,
      ),
    );
  }

  /// A verification code is only valid for the exact address it was sent
  /// to, so changing the address throws the verification away.
  void _invalidateEmailVerification() {
    if (!mounted) return;
    if (!_emailVerified && _emailChallenge.isEmpty) return;
    setState(() {
      _emailVerified = false;
      _emailChallenge = '';
    });
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final authState = ref.watch(authControllerProvider);

    ref.listen(authControllerProvider, (previous, next) {
      if (next.hasError && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(readableAuthError(next.error!)),
            backgroundColor: theme.colorScheme.error,
          ),
        );
      }
    });

    return Scaffold(
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(AppSpacing.xl),
          child: Form(
            key: _formKey,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const SizedBox(height: AppSpacing.lg),
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
                        'Create Account',
                        style: theme.textTheme.headlineMedium,
                      ),
                      const SizedBox(height: AppSpacing.sm),
                      Text(
                        'Join StayServe to find your perfect stay',
                        style: theme.textTheme.bodyMedium?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: AppSpacing.xl),
                Text('I am a', style: theme.textTheme.labelLarge),
                const SizedBox(height: AppSpacing.sm),
                // The two choices stand under each other. Side by side they
                // were squeezed into a narrow column on a small phone, and
                // their words ran into each other.
                _RoleCard(
                  role: UserRole.student,
                  title: 'Student',
                  subtitle: 'Looking for a room to rent',
                  icon: Icons.school_outlined,
                  selected: _selectedRole == UserRole.student,
                  onTap: () => setState(() => _selectedRole = UserRole.student),
                ),
                const SizedBox(height: AppSpacing.sm),
                _RoleCard(
                  role: UserRole.owner,
                  title: 'Room Owner',
                  subtitle: 'Have rooms to rent out',
                  icon: Icons.apartment_outlined,
                  selected: _selectedRole == UserRole.owner,
                  onTap: () => setState(() => _selectedRole = UserRole.owner),
                ),
                const SizedBox(height: AppSpacing.lg),
                AppTextField(
                  controller: _nameController,
                  label: 'Full Name',
                  hint: 'Enter your full name',
                  textInputAction: TextInputAction.next,
                  validator: AppValidators.validateName,
                  prefixIcon: const Icon(Icons.person_outline),
                  textCapitalization: TextCapitalization.words,
                  maxLength: AppValidators.maxNameLength,
                ),
                const SizedBox(height: AppSpacing.md),
                AppTextField(
                  controller: _emailController,
                  label: 'Email',
                  hint: 'Enter your email',
                  keyboardType: TextInputType.emailAddress,
                  textInputAction: TextInputAction.next,
                  validator: AppValidators.validateEmail,
                  prefixIcon: const Icon(Icons.email_outlined),
                  // Editing the address invalidates the previous code.
                  onChanged: (_) => _invalidateEmailVerification(),
                  suffixIcon: _emailVerified
                      ? Icon(Icons.verified, color: theme.colorScheme.primary)
                      : null,
                ),
                const SizedBox(height: AppSpacing.md),
                AppTextField(
                  controller: _passwordController,
                  label: 'Password',
                  hint: 'Enter password (min 6 characters)',
                  obscureText: _obscurePassword,
                  textInputAction: TextInputAction.next,
                  validator: AppValidators.validatePassword,
                  prefixIcon: const Icon(Icons.lock_outline),
                  suffixIcon: IconButton(
                    icon: Icon(
                      _obscurePassword
                          ? Icons.visibility_outlined
                          : Icons.visibility_off_outlined,
                    ),
                    onPressed: () =>
                        setState(() => _obscurePassword = !_obscurePassword),
                  ),
                ),
                const SizedBox(height: AppSpacing.md),
                AppTextField(
                  controller: _confirmPasswordController,
                  label: 'Confirm Password',
                  hint: 'Confirm your password',
                  obscureText: _obscureConfirmPassword,
                  textInputAction: TextInputAction.done,
                  validator: (value) => AppValidators.validateConfirmPassword(
                    value,
                    _passwordController.text,
                  ),
                  prefixIcon: const Icon(Icons.lock_outline),
                  suffixIcon: IconButton(
                    icon: Icon(
                      _obscureConfirmPassword
                          ? Icons.visibility_outlined
                          : Icons.visibility_off_outlined,
                    ),
                    onPressed: () => setState(
                      () => _obscureConfirmPassword = !_obscureConfirmPassword,
                    ),
                  ),
                  onFieldSubmitted: (_) => _handleRegister(),
                ),
                const SizedBox(height: AppSpacing.lg),
                AppButton(
                  label: 'Create Account',
                  onPressed: _handleRegister,
                  isLoading: authState.isLoading,
                ),
                const SizedBox(height: AppSpacing.lg),
                Row(
                  children: [
                    const Expanded(child: Divider()),
                    Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: AppSpacing.sm,
                      ),
                      child: Text('or', style: theme.textTheme.bodySmall),
                    ),
                    const Expanded(child: Divider()),
                  ],
                ),
                const SizedBox(height: AppSpacing.md),
                AppButton(
                  label: 'Continue with Google',
                  type: ButtonType.secondary,
                  icon: const Icon(Icons.g_mobiledata, size: 24),
                  onPressed: authState.isLoading ? null : _continueWithGoogle,
                ),
                const SizedBox(height: AppSpacing.sm),
                AppButton(
                  label: 'Continue with Phone',
                  type: ButtonType.secondary,
                  icon: const Icon(Icons.phone_outlined),
                  onPressed: authState.isLoading ? null : _continueWithPhone,
                ),
                const SizedBox(height: AppSpacing.sm),
                Text(
                  'Phone-only accounts may add a verified email later. A '
                  'verified phone is required before using student or owner '
                  'services.',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: AppSpacing.xl),
                Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    // The text wraps instead of pushing the button off the
                    // screen when the font of the phone is large.
                    Flexible(
                      child: Text(
                        'Already have an account? ',
                        style: theme.textTheme.bodyMedium?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ),
                    TextButton(
                      onPressed: () => context.go('/login'),
                      child: const Text('Sign In'),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _RoleCard extends StatelessWidget {
  final UserRole role;
  final String title;
  final String subtitle;
  final IconData icon;
  final bool selected;
  final VoidCallback onTap;

  const _RoleCard({
    required this.role,
    required this.title,
    required this.subtitle,
    required this.icon,
    required this.selected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(AppBorderRadius.lg),
      child: AnimatedContainer(
        duration: AppConstants.animationDuration,
        padding: const EdgeInsets.all(AppSpacing.md),
        decoration: BoxDecoration(
          color: selected
              ? theme.colorScheme.primaryContainer
              : theme.colorScheme.surface,
          borderRadius: BorderRadius.circular(AppBorderRadius.lg),
          border: Border.all(
            color: selected
                ? theme.colorScheme.primary
                : theme.colorScheme.outlineVariant,
            width: selected ? 2 : 1,
          ),
        ),
        // The icon sits beside the words. The text gets the whole width of
        // the card and wraps on its own lines, so nothing can overlap.
        child: Row(
          children: [
            Container(
              width: 44,
              height: 44,
              decoration: BoxDecoration(
                color: selected
                    ? theme.colorScheme.primary
                    : theme.colorScheme.primaryContainer,
                borderRadius: BorderRadius.circular(AppBorderRadius.md),
              ),
              child: Icon(
                icon,
                size: 24,
                color: selected
                    ? theme.colorScheme.onPrimary
                    : theme.colorScheme.primary,
              ),
            ),
            const SizedBox(width: AppSpacing.md),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    title,
                    style: theme.textTheme.titleMedium?.copyWith(
                      color: selected
                          ? theme.colorScheme.primary
                          : theme.colorScheme.onSurface,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: AppSpacing.xs),
                  Text(
                    subtitle,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ),
            if (selected) ...[
              const SizedBox(width: AppSpacing.sm),
              Icon(
                Icons.check_circle,
                color: theme.colorScheme.primary,
                size: 24,
              ),
            ],
          ],
        ),
      ),
    );
  }
}
