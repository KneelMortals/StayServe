import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/index.dart';
import '../providers/auth_provider.dart';

class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _formKey = GlobalKey<FormState>();
  final _emailController = TextEditingController();
  final _passwordController = TextEditingController();
  bool _obscurePassword = true;

  @override
  void dispose() {
    _emailController.dispose();
    _passwordController.dispose();
    super.dispose();
  }

  Future<void> _handleLogin() async {
    if (!_formKey.currentState!.validate()) {
      AppLogger.warning('The sign-in form did not validate');
      return;
    }

    AppLogger.info(
      'Signing in as ${AppHelpers.maskEmail(_emailController.text.trim())}',
    );

    await ref
        .read(authControllerProvider.notifier)
        .signIn(
          email: _emailController.text.trim(),
          password: _passwordController.text,
        );

    final state = ref.read(authControllerProvider);
    AppLogger.info(
      'The sign-in finished: hasError=${state.hasError}'
      '${state.hasError ? " (${readableAuthError(state.error!)})" : ""}',
    );
  }

  Future<void> _handleGoogleSignIn() async {
    await ref.read(authControllerProvider.notifier).signInWithGoogle();
    if (!mounted) return;
    if (ref.read(authControllerProvider).error == null) {
      context.go('/role-selection');
    }
  }

  void _handlePhoneSignIn() {
    context.go('/phone-auth');
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final authState = ref.watch(authControllerProvider);

    ref.listen(authControllerProvider, (previous, next) {
      if (next.hasError && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            // The raw exception used to be shown here, which dumped
            // framework internals such as
            // "FirebaseAuthException [firebase_auth/invalid-credential] …"
            // into the screen. That looked like an "auth issue" even when
            // the sign-in had failed for a completely ordinary reason.
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
                        'Welcome Back',
                        style: theme.textTheme.headlineMedium,
                      ),
                      const SizedBox(height: AppSpacing.sm),
                      Text(
                        'Sign in to your StayServe account',
                        style: theme.textTheme.bodyMedium?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: AppSpacing.xxl),
                AppTextField(
                  controller: _emailController,
                  label: 'Email',
                  hint: 'Enter your email',
                  keyboardType: TextInputType.emailAddress,
                  textInputAction: TextInputAction.next,
                  validator: AppValidators.validateEmail,
                  prefixIcon: const Icon(Icons.email_outlined),
                ),
                const SizedBox(height: AppSpacing.md),
                AppTextField(
                  controller: _passwordController,
                  label: 'Password',
                  hint: 'Enter your password',
                  obscureText: _obscurePassword,
                  textInputAction: TextInputAction.done,
                  validator: (value) =>
                      AppValidators.validateRequired(value, 'Password'),
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
                  onFieldSubmitted: (_) => _handleLogin(),
                ),
                const SizedBox(height: AppSpacing.sm),
                Align(
                  alignment: Alignment.centerRight,
                  child: TextButton(
                    onPressed: () => context.push('/forgot-password'),
                    child: const Text('Forgot Password?'),
                  ),
                ),
                const SizedBox(height: AppSpacing.lg),
                AppButton(
                  label: 'Sign In',
                  onPressed: _handleLogin,
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
                  onPressed: authState.isLoading ? null : _handleGoogleSignIn,
                ),
                const SizedBox(height: AppSpacing.sm),
                AppButton(
                  label: 'Sign in with Phone',
                  type: ButtonType.secondary,
                  icon: const Icon(Icons.phone_outlined),
                  onPressed: authState.isLoading ? null : _handlePhoneSignIn,
                ),
                const SizedBox(height: AppSpacing.xl),
                // A `Wrap` and not a `Row`: on a narrow phone (400 px) the
                // row was 114 pixels too wide and the "Sign Up" button was
                // cut off. The wrap puts the button on its own line when
                // there is not enough room.
                Wrap(
                  alignment: WrapAlignment.center,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  spacing: AppSpacing.xs,
                  children: [
                    Text(
                      'Don\'t have an account?',
                      style: theme.textTheme.bodyMedium?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                    TextButton(
                      onPressed: () => context.push('/register'),
                      child: const Text('Sign Up'),
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
