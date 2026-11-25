import 'package:material_ui/material_ui.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/index.dart';
import '../../../../models/user_model.dart';
import '../../../../firebase/otp/otp_service.dart';
import '../../../auth/presentation/providers/auth_provider.dart';

/// Lets the signed-in user change their name and profile picture and manage
/// their verified authentication methods.
///
/// The phone number and its verification flag are server-owned. They can
/// only be changed through Firebase Phone Auth. A phone-first account may
/// add a verified email later with StayServe's one-time email proof.
class EditProfileScreen extends ConsumerStatefulWidget {
  const EditProfileScreen({super.key});

  @override
  ConsumerState<EditProfileScreen> createState() => _EditProfileScreenState();
}

class _EditProfileScreenState extends ConsumerState<EditProfileScreen> {
  final _formKey = GlobalKey<FormState>();
  final _nameController = TextEditingController();
  final _imageController = TextEditingController();

  bool _isSaving = false;
  bool _prefilled = false;

  @override
  void dispose() {
    _nameController.dispose();
    _imageController.dispose();
    super.dispose();
  }

  /// Fills the fields with the current profile — once, as soon as the
  /// profile is available.
  void _prefill(UserModel profile) {
    if (_prefilled) return;
    _prefilled = true;
    _nameController.text = profile.name;
    _imageController.text = profile.profileImage ?? '';
  }

  Future<void> _save() async {
    if (!_formKey.currentState!.validate()) return;

    setState(() => _isSaving = true);
    try {
      final image = _imageController.text.trim();
      await ref
          .read(authControllerProvider.notifier)
          .updateProfile(
            name: _nameController.text.trim(),
            profileImage: image.isEmpty ? null : image,
            // An empty field removes the picture — the old code silently
            // kept the old one.
            removeProfileImage: image.isEmpty,
          );

      if (!mounted) return;
      context.showSuccessSnackBar('Profile updated');
      context.pop();
    } catch (error) {
      if (!mounted) return;
      context.showErrorSnackBar(readableAuthError(error));
    } finally {
      if (mounted) setState(() => _isSaving = false);
    }
  }

  Future<void> _addVerifiedEmail() async {
    var enteredEmail = '';
    final email = await showDialog<String>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Add verified email'),
        content: TextFormField(
          autofocus: true,
          keyboardType: TextInputType.emailAddress,
          initialValue: enteredEmail,
          onChanged: (value) => enteredEmail = value.trim(),
          decoration: const InputDecoration(
            labelText: 'Email address',
            prefixIcon: Icon(Icons.email_outlined),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () {
              if (AppValidators.validateEmail(enteredEmail) != null) return;
              Navigator.of(dialogContext).pop(enteredEmail);
            },
            child: const Text('Continue'),
          ),
        ],
      ),
    );

    if (!mounted || email == null || email.trim().isEmpty) return;

    final challenge = await context.push<String>(
      Uri(
        path: '/verify-otp',
        queryParameters: {
          'channel': OtpChannel.email.name,
          'identifier': email.trim(),
        },
      ).toString(),
    );
    if (!mounted || challenge == null || challenge.isEmpty) return;

    try {
      await ref
          .read(authControllerProvider.notifier)
          .linkVerifiedEmail(email: email.trim(), challenge: challenge);
      if (!mounted) return;
      context.showSuccessSnackBar('Verified email added');
    } catch (error) {
      if (!mounted) return;
      context.showErrorSnackBar(readableAuthError(error));
    }
  }

  Future<void> _linkGoogle() async {
    try {
      await ref.read(authControllerProvider.notifier).linkGoogleProvider();
      if (!mounted) return;
      context.showSuccessSnackBar('Google account linked');
    } catch (error) {
      if (!mounted) return;
      context.showErrorSnackBar(readableAuthError(error));
    }
  }

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(authSessionProvider).valueOrNull;
    final profile = session?.profile;
    final profileBusy = ref.watch(profileMutationBusyProvider);

    if (profile != null) _prefill(profile);

    return Scaffold(
      appBar: AppBar(title: const Text('Edit Profile')),
      body: profile == null
          ? const Center(child: CircularProgressIndicator())
          : SingleChildScrollView(
              padding: const EdgeInsets.all(AppSpacing.md),
              child: Form(
                key: _formKey,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Center(
                      child: Column(
                        children: [
                          AppAvatar(
                            name: _nameController.text.trim().isEmpty
                                ? profile.name
                                : _nameController.text.trim(),
                            imageUrl: _imageController.text.trim().isEmpty
                                ? profile.profileImage
                                : _imageController.text.trim(),
                            radius: 50,
                          ),
                          const SizedBox(height: AppSpacing.sm),
                          Text(
                            profile.email.isEmpty
                                ? 'No email address yet'
                                : profile.email,
                            style: Theme.of(context).textTheme.bodyMedium,
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: AppSpacing.lg),
                    AppTextField(
                      label: 'Full name',
                      hint: 'Your name',
                      controller: _nameController,
                      validator: (value) =>
                          AppValidators.validateRequired(value, 'Name'),
                      prefixIcon: const Icon(Icons.person_outline),
                      enabled: !profileBusy,
                      onChanged: (_) => setState(() {}),
                    ),
                    const SizedBox(height: AppSpacing.md),
                    AppTextField(
                      label: 'Profile image URL (optional)',
                      hint: 'https://…',
                      controller: _imageController,
                      keyboardType: TextInputType.url,
                      prefixIcon: const Icon(Icons.image_outlined),
                      enabled: !profileBusy,
                    ),
                    const SizedBox(height: AppSpacing.lg),
                    Text(
                      'Verified sign-in methods',
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    const SizedBox(height: AppSpacing.sm),
                    Card(
                      child: ListTile(
                        leading: Icon(
                          profile.phoneVerified
                              ? Icons.verified
                              : Icons.phone_outlined,
                          color: profile.phoneVerified
                              ? Theme.of(context).colorScheme.primary
                              : Theme.of(context).colorScheme.onSurfaceVariant,
                        ),
                        title: Text(
                          profile.phone?.isNotEmpty == true
                              ? profile.phone!
                              : 'No verified phone number',
                        ),
                        subtitle: Text(
                          profile.phoneVerified
                              ? 'Firebase SMS verified'
                              : 'A verified phone is required for services',
                        ),
                        trailing: profile.phoneVerified
                            ? null
                            : TextButton(
                                onPressed: profileBusy
                                    ? null
                                    : () => context.go('/verify-phone'),
                                child: const Text('Verify'),
                              ),
                      ),
                    ),
                    const SizedBox(height: AppSpacing.sm),
                    Card(
                      child: ListTile(
                        leading: Icon(
                          profile.emailVerified
                              ? Icons.verified
                              : Icons.email_outlined,
                          color: profile.emailVerified
                              ? Theme.of(context).colorScheme.primary
                              : Theme.of(context).colorScheme.onSurfaceVariant,
                        ),
                        title: Text(
                          profile.email.isEmpty
                              ? 'No email address'
                              : profile.email,
                        ),
                        subtitle: Text(
                          profile.emailVerified
                              ? 'Email ownership verified'
                              : 'You can add a verified email later',
                        ),
                        trailing: profile.emailVerified
                            ? null
                            : TextButton(
                                onPressed: profileBusy
                                    ? null
                                    : _addVerifiedEmail,
                                child: const Text('Add'),
                              ),
                      ),
                    ),
                    if (!profile.authProviders.contains('google.com')) ...[
                      const SizedBox(height: AppSpacing.sm),
                      Card(
                        child: ListTile(
                          leading: const Icon(Icons.g_mobiledata),
                          title: const Text('Google account'),
                          subtitle: const Text(
                            'Link Google OpenID Connect for another sign-in method',
                          ),
                          trailing: TextButton(
                            onPressed: profileBusy ? null : _linkGoogle,
                            child: const Text('Link'),
                          ),
                        ),
                      ),
                    ],
                    const SizedBox(height: AppSpacing.lg),
                    AppButton(
                      label: 'Save changes',
                      isLoading: _isSaving || profileBusy,
                      onPressed: _isSaving || profileBusy ? null : _save,
                      type: ButtonType.primary,
                    ),
                  ],
                ),
              ),
            ),
    );
  }
}
