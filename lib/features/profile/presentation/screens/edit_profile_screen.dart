import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../core/index.dart';
import '../../../../models/user_model.dart';
import '../../../auth/presentation/providers/auth_provider.dart';

/// Lets the signed-in user change their name, phone number and profile
/// picture.
///
/// This screen used to be linked from the student profile
/// (`/student/profile/edit`) but **did not exist** — the router fell
/// through to its "Page Not Found" error page. It is now registered for
/// both the student and the owner area.
class EditProfileScreen extends ConsumerStatefulWidget {
  const EditProfileScreen({super.key});

  @override
  ConsumerState<EditProfileScreen> createState() => _EditProfileScreenState();
}

class _EditProfileScreenState extends ConsumerState<EditProfileScreen> {
  final _formKey = GlobalKey<FormState>();
  final _nameController = TextEditingController();
  final _phoneController = TextEditingController();
  final _imageController = TextEditingController();

  bool _isSaving = false;
  bool _prefilled = false;

  @override
  void dispose() {
    _nameController.dispose();
    _phoneController.dispose();
    _imageController.dispose();
    super.dispose();
  }

  /// Fills the fields with the current profile — once, as soon as the
  /// profile is available.
  void _prefill(UserModel profile) {
    if (_prefilled) return;
    _prefilled = true;
    _nameController.text = profile.name;
    _phoneController.text = profile.phone ?? '';
    _imageController.text = profile.profileImage ?? '';
  }

  Future<void> _save() async {
    if (!_formKey.currentState!.validate()) return;

    setState(() => _isSaving = true);
    try {
      final image = _imageController.text.trim();
      await ref.read(authControllerProvider.notifier).updateProfile(
            name: _nameController.text.trim(),
            phone: _phoneController.text.trim(),
            profileImage: image.isEmpty ? null : image,
            // An empty field removes the picture — the old code silently
            // kept the old one.
            removeProfileImage: image.isEmpty,
          );

      if (!mounted) return;
      context.showSuccessSnackBar('Profile updated');
      context.pop();
    } catch (e) {
      if (!mounted) return;
      context.showErrorSnackBar(
        e.toString().replaceFirst('Exception: ', ''),
      );
    } finally {
      if (mounted) setState(() => _isSaving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(authSessionProvider).valueOrNull;
    final profile = session?.profile;

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
                            profile.email,
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
                      validator: (value) => AppValidators.validateRequired(
                        value,
                        'Name',
                      ),
                      prefixIcon: const Icon(Icons.person_outline),
                      onChanged: (_) => setState(() {}),
                    ),
                    const SizedBox(height: AppSpacing.md),
                    AppTextField(
                      label: 'Phone number (optional)',
                      hint: '10-digit mobile number',
                      controller: _phoneController,
                      keyboardType: TextInputType.phone,
                      validator: AppValidators.validatePhone,
                      prefixIcon: const Icon(Icons.phone_outlined),
                    ),
                    const SizedBox(height: AppSpacing.md),
                    AppTextField(
                      label: 'Profile image URL (optional)',
                      hint: 'https://…',
                      controller: _imageController,
                      keyboardType: TextInputType.url,
                      prefixIcon: const Icon(Icons.image_outlined),
                    ),
                    const SizedBox(height: AppSpacing.lg),
                    AppButton(
                      label: 'Save changes',
                      isLoading: _isSaving,
                      onPressed: _isSaving ? null : _save,
                      type: ButtonType.primary,
                    ),
                  ],
                ),
              ),
            ),
    );
  }
}
