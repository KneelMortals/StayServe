import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

import '../../../../core/index.dart';
import '../../../../../firebase/owner/owner_repository.dart';
import '../../../../../models/room_model.dart';
import '../../../../../services/location_service.dart';

/// Reusable form used to create and edit a room listing.
///
/// When [initialRoom] is supplied the form is pre-filled with that listing.
class RoomForm extends ConsumerStatefulWidget {
  final RoomModel? initialRoom;

  /// The homes the owner already publishes rooms in.
  ///
  /// They are offered in the "Home" picker, so another room of the same
  /// house can be published without typing the address again.
  final List<OwnerHome> homes;

  /// The home the new listing belongs to.
  final String? initialHomeId;

  final Future<void> Function(RoomDraft draft) onSubmit;
  final String submitLabel;

  const RoomForm({
    required this.onSubmit,
    this.initialRoom,
    this.homes = const [],
    this.initialHomeId,
    this.submitLabel = 'Save Listing',
    super.key,
  });

  @override
  ConsumerState<RoomForm> createState() => _RoomFormState();
}

class _RoomFormState extends ConsumerState<RoomForm> {
  final _formKey = GlobalKey<FormState>();
  final _imagePicker = ImagePicker();

  late final TextEditingController _titleController;
  late final TextEditingController _descriptionController;
  late final TextEditingController _rentController;
  late final TextEditingController _depositController;
  late final TextEditingController _addressController;
  late final TextEditingController _cityController;
  late final TextEditingController _stateController;
  late final TextEditingController _pincodeController;
  late final TextEditingController _occupancyController;
  late final TextEditingController _homeNameController;

  late RoomType _roomType;
  late FurnishingType _furnishing;
  late GenderPreference _gender;
  late DateTime _availableFrom;
  late List<String> _amenities;

  /// The photos the owner already uploaded.
  late List<String> _existingImages;

  /// The photos the owner just picked (they live on the device only).
  final List<_PickedImage> _newImages = [];

  /// The home this listing belongs to.
  ///
  /// `null` means "a brand new home".
  String? _selectedHomeId;

  /// The coordinates of the listing.
  double? _latitude;
  double? _longitude;

  bool _isSaving = false;
  bool _isPickingLocation = false;

  @override
  void initState() {
    super.initState();
    final room = widget.initialRoom;

    _titleController = TextEditingController(text: room?.title ?? '');
    _descriptionController = TextEditingController(
      text: room?.description ?? '',
    );
    _rentController = TextEditingController(
      text: room == null ? '' : room.monthlyRent.toStringAsFixed(0),
    );
    _depositController = TextEditingController(
      text: room == null ? '' : room.securityDeposit.toStringAsFixed(0),
    );
    _addressController = TextEditingController(
      text: room?.location.address ?? '',
    );
    _cityController = TextEditingController(text: room?.location.city ?? '');
    _stateController = TextEditingController(text: room?.location.state ?? '');
    _pincodeController = TextEditingController(
      text: room?.location.pincode ?? '',
    );
    _occupancyController = TextEditingController(
      text: '${room?.occupancy ?? 1}',
    );

    _roomType = room?.roomType ?? RoomType.single;
    _furnishing = room?.furnishing ?? FurnishingType.unfurnished;
    _gender = room?.genderPreference ?? GenderPreference.any;
    _availableFrom = room?.availableFrom ?? DateTime.now();
    _amenities = [...?room?.amenities];

    _existingImages = [...?room?.images];
    _selectedHomeId = room?.homeId ?? widget.initialHomeId;
    _homeNameController = TextEditingController(
      text:
          room?.homeName ??
          (widget.initialHomeId != null
              ? _nameOfHome(widget.initialHomeId!)
              : ''),
    );

    _latitude = room?.latitude ?? room?.location.latitude;
    _longitude = room?.longitude ?? room?.location.longitude;
  }

  @override
  void dispose() {
    _titleController.dispose();
    _descriptionController.dispose();
    _rentController.dispose();
    _depositController.dispose();
    _addressController.dispose();
    _cityController.dispose();
    _stateController.dispose();
    _pincodeController.dispose();
    _occupancyController.dispose();
    _homeNameController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;

    setState(() => _isSaving = true);

    final existing = widget.initialRoom;
    final now = DateTime.now();

    final homeName = _homeNameController.text.trim();
    final homeId =
        _selectedHomeId ??
        (homeName.isEmpty
            ? null
            : 'HOME-${DateTime.now().millisecondsSinceEpoch}');

    final room = RoomModel(
      roomId: existing?.roomId ?? '',
      ownerId: existing?.ownerId ?? '',
      title: _titleController.text.trim(),
      description: _descriptionController.text.trim(),
      monthlyRent: double.parse(_rentController.text.trim()),
      securityDeposit: double.parse(_depositController.text.trim()),
      location: Location(
        address: _addressController.text.trim(),
        city: _cityController.text.trim(),
        state: _stateController.text.trim(),
        pincode: _pincodeController.text.trim(),
        latitude: _latitude,
        longitude: _longitude,
      ),
      roomType: _roomType,
      furnishing: _furnishing,
      availableFrom: _availableFrom,
      amenities: _amenities,
      occupancy: int.tryParse(_occupancyController.text.trim()) ?? 1,
      currentOccupancy: existing?.currentOccupancy ?? 0,
      genderPreference: _gender,
      images: _existingImages,
      // The status is server-owned: a new listing starts as `available`, and
      // an existing listing keeps the status it has (it is changed through
      // the "My rooms" screen, never through this form).
      status: existing?.status ?? RoomStatus.available,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      latitude: _latitude,
      longitude: _longitude,
      homeId: homeId,
      homeName: homeName.isEmpty && homeId != null
          ? _homeNameFor(homeId)
          : (homeName.isEmpty ? null : homeName),
    );

    try {
      await widget.onSubmit(
        RoomDraft(
          room: room,
          newImages: _newImages.map((p) => p.file).toList(),
        ),
      );
      if (!mounted) return;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('Listing saved')));
      Navigator.of(context).pop(true);
    } catch (e) {
      if (!mounted) return;
      setState(() => _isSaving = false);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(e.toString().replaceFirst('Exception: ', '')),
          backgroundColor: Theme.of(context).colorScheme.error,
        ),
      );
    }
  }

  /// The name of an already existing home.
  String? _homeNameFor(String homeId) {
    for (final home in widget.homes) {
      if (home.id == homeId) return home.name;
    }
    return widget.initialRoom?.homeName;
  }

  /// The name of the home with the given id.
  String? _nameOfHome(String homeId) {
    for (final home in widget.homes) {
      if (home.id == homeId) return home.name;
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    return Form(
      key: _formKey,
      child: ListView(
        padding: const EdgeInsets.all(AppSpacing.md),
        children: [
          _buildSectionTitle('Photos'),
          _buildPhotoPicker(context),
          const SizedBox(height: AppSpacing.lg),
          _buildSectionTitle('Basic Information'),
          AppTextField(
            controller: _titleController,
            label: 'Room Title',
            hint: 'e.g., Cozy Single Room in Koramangala',
            validator: (v) => AppValidators.validateRequired(v, 'Title'),
          ),
          const SizedBox(height: AppSpacing.md),
          AppTextField(
            controller: _descriptionController,
            label: 'Description',
            hint:
                'Describe the room, the amenities, the rules and the nearby '
                'facilities (bus stop, college, market)...',
            maxLines: 5,
            validator: (v) => AppValidators.validateRequired(v, 'Description'),
          ),
          const SizedBox(height: AppSpacing.lg),
          _buildSectionTitle('Pricing'),
          // -----------------------------------------------------------------
          // The two fields sit next to each other, so their labels have to
          // be short: "Security Deposit (₹)" is wider than a half of the
          // screen and the floating label was drawn over the neighbouring
          // field.
          // -----------------------------------------------------------------
          Row(
            children: [
              Expanded(
                child: AppTextField(
                  controller: _rentController,
                  label: 'Rent (₹)',
                  hint: 'per month',
                  keyboardType: TextInputType.number,
                  validator: (v) =>
                      AppValidators.validateMinValue(v, 1000, 'Rent'),
                ),
              ),
              const SizedBox(width: AppSpacing.md),
              Expanded(
                child: AppTextField(
                  controller: _depositController,
                  label: 'Deposit (₹)',
                  hint: 'refundable',
                  keyboardType: TextInputType.number,
                  validator: (v) =>
                      AppValidators.validateMinValue(v, 0, 'Deposit'),
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.lg),
          _buildSectionTitle('Room Details'),
          _buildDropdown<RoomType>(
            label: 'Room Type',
            value: _roomType,
            items: RoomType.values,
            onChanged: (v) => setState(() => _roomType = v!),
            getLabel: (e) => e.label,
          ),
          const SizedBox(height: AppSpacing.md),
          _buildDropdown<FurnishingType>(
            label: 'Furnishing',
            value: _furnishing,
            items: FurnishingType.values,
            onChanged: (v) => setState(() => _furnishing = v!),
            getLabel: (e) => e.label,
          ),
          const SizedBox(height: AppSpacing.md),
          _buildDropdown<GenderPreference>(
            label: 'Gender Preference',
            value: _gender,
            items: GenderPreference.values,
            onChanged: (v) => setState(() => _gender = v!),
            getLabel: (e) => e.label,
          ),
          const SizedBox(height: AppSpacing.md),
          // The listing status is **server-owned**: it is changed through the
          // "Mark occupied" / "Mark available" action on the "My rooms"
          // screen (the `setRoomListingAvailability` callable), not here.
          // A dropdown whose value was silently dropped on save would only
          // confuse the owner.
          if (widget.initialRoom != null)
            _buildReadOnlyStatus(widget.initialRoom!.status),
          const SizedBox(height: AppSpacing.md),
          AppTextField(
            controller: _occupancyController,
            label: 'Occupancy',
            keyboardType: TextInputType.number,
            validator: (v) {
              final value = int.tryParse(v?.trim() ?? '');
              if (value == null || value < 1) {
                return 'Enter a valid occupancy';
              }
              return null;
            },
          ),
          const SizedBox(height: AppSpacing.md),
          InkWell(
            onTap: _pickAvailableFrom,
            borderRadius: BorderRadius.circular(AppBorderRadius.md),
            child: InputDecorator(
              decoration: const InputDecoration(labelText: 'Available From'),
              child: Text(
                AppFormatters.formatDate(_availableFrom),
                style: Theme.of(context).textTheme.bodyLarge,
              ),
            ),
          ),
          const SizedBox(height: AppSpacing.lg),
          _buildSectionTitle('Home'),
          _buildHomePicker(context),
          const SizedBox(height: AppSpacing.md),
          AppTextField(
            controller: _homeNameController,
            label: 'Home name',
            hint: 'e.g., Sunrise Apartments, Flat 3B',
            onChanged: (_) => setState(() {}),
          ),
          const SizedBox(height: AppSpacing.lg),
          _buildSectionTitle('Location'),
          _buildLocationPicker(context),
          const SizedBox(height: AppSpacing.md),
          AppTextField(
            controller: _addressController,
            label: 'Address',
            hint: 'Street address, landmark',
            validator: (v) => AppValidators.validateRequired(v, 'Address'),
          ),
          const SizedBox(height: AppSpacing.md),
          Row(
            children: [
              Expanded(
                child: AppTextField(
                  controller: _cityController,
                  label: 'City',
                  hint: 'Bangalore',
                  validator: (v) => AppValidators.validateRequired(v, 'City'),
                ),
              ),
              const SizedBox(width: AppSpacing.md),
              Expanded(
                child: AppTextField(
                  controller: _stateController,
                  label: 'State',
                  hint: 'Karnataka',
                  validator: (v) => AppValidators.validateRequired(v, 'State'),
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.md),
          AppTextField(
            controller: _pincodeController,
            label: 'Pincode',
            keyboardType: TextInputType.number,
            validator: (v) => AppValidators.validateRequired(v, 'Pincode'),
          ),
          const SizedBox(height: AppSpacing.lg),
          _buildSectionTitle('Amenities'),
          _buildAmenitiesSelector(),
          const SizedBox(height: AppSpacing.xl),
          AppButton(
            label: widget.submitLabel,
            onPressed: _isSaving ? null : _submit,
            isLoading: _isSaving,
          ),
        ],
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // Photos
  // ---------------------------------------------------------------------------

  Widget _buildPhotoPicker(BuildContext context) {
    final theme = Theme.of(context);
    final total = _existingImages.length + _newImages.length;
    final isFull = total >= AppConstants.maxImagesPerRoom;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (total == 0)
          Container(
            width: double.infinity,
            padding: const EdgeInsets.all(AppSpacing.lg),
            decoration: BoxDecoration(
              color: theme.colorScheme.surfaceContainerHighest,
              borderRadius: BorderRadius.circular(AppBorderRadius.md),
              border: Border.all(color: theme.colorScheme.outlineVariant),
            ),
            child: Column(
              children: [
                Icon(
                  Icons.add_a_photo_outlined,
                  size: 36,
                  color: theme.colorScheme.primary,
                ),
                const SizedBox(height: AppSpacing.sm),
                Text(
                  'Add photos of the room',
                  style: theme.textTheme.bodyMedium,
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: AppSpacing.xs),
                Text(
                  'Students are far more likely to book a room with pictures.',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                  textAlign: TextAlign.center,
                ),
              ],
            ),
          ),
        if (total > 0)
          SizedBox(
            height: 100,
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              itemCount: total,
              separatorBuilder: (_, __) => const SizedBox(width: AppSpacing.sm),
              itemBuilder: (context, index) {
                if (index < _existingImages.length) {
                  return _buildImageTile(
                    context,
                    imageUrl: _existingImages[index],
                    onRemove: () => setState(() {
                      _existingImages.removeAt(index);
                    }),
                  );
                }
                final file = _newImages[index - _existingImages.length];
                return _buildImageTile(
                  context,
                  picked: file,
                  onRemove: () => setState(() {
                    _newImages.removeAt(index - _existingImages.length);
                  }),
                );
              },
            ),
          ),
        const SizedBox(height: AppSpacing.sm),
        OutlinedButton.icon(
          onPressed: isFull ? null : _pickImages,
          icon: const Icon(Icons.photo_library_outlined),
          label: Text(
            isFull
                ? 'Maximum ${AppConstants.maxImagesPerRoom} photos reached'
                : total == 0
                ? 'Add photos'
                : 'Add more photos',
          ),
        ),
      ],
    );
  }

  Widget _buildImageTile(
    BuildContext context, {
    String? imageUrl,
    _PickedImage? picked,
    required VoidCallback onRemove,
  }) {
    final theme = Theme.of(context);

    return Stack(
      children: [
        ClipRRect(
          borderRadius: BorderRadius.circular(AppBorderRadius.md),
          child: SizedBox(
            width: 100,
            height: 100,
            child: picked != null
                ? Image.memory(
                    picked.bytes,
                    fit: BoxFit.cover,
                    errorBuilder: (_, __, ___) => Container(
                      color: theme.colorScheme.surfaceContainerHighest,
                      child: const Icon(Icons.broken_image_outlined),
                    ),
                  )
                : AppImage(
                    imageUrl: imageUrl,
                    fit: BoxFit.cover,
                    placeholder: Container(
                      color: theme.colorScheme.surfaceContainerHighest,
                      child: const Icon(Icons.broken_image_outlined),
                    ),
                  ),
          ),
        ),
        Positioned(
          top: 2,
          right: 2,
          child: InkWell(
            onTap: onRemove,
            child: Container(
              padding: const EdgeInsets.all(2),
              decoration: BoxDecoration(
                color: theme.colorScheme.error,
                shape: BoxShape.circle,
              ),
              child: Icon(
                Icons.close,
                size: 16,
                color: theme.colorScheme.onError,
              ),
            ),
          ),
        ),
      ],
    );
  }

  Future<void> _pickImages() async {
    try {
      final images = await _imagePicker.pickMultiImage(
        imageQuality: AppConstants.imageCompressionQuality,
        maxWidth: 1600,
      );
      if (images.isEmpty) return;

      final room = _existingImages.length + _newImages.length;
      final remaining = AppConstants.maxImagesPerRoom - room;
      if (remaining <= 0) {
        _showMessage(
          'You can add at most ${AppConstants.maxImagesPerRoom} photos.',
        );
        return;
      }

      setState(() {
        for (final image in images.take(remaining)) {
          // The bytes are read right away so the preview can be shown
          // without touching the file system again.
          _newImages.add(_PickedImage(image, Uint8List(0)));
        }
      });

      // The bytes are loaded in the background — the preview fills in as
      // soon as they are there.
      unawaited(_loadBytes(images.take(remaining).toList()));

      if (images.length > remaining) {
        _showMessage(
          'Only ${AppConstants.maxImagesPerRoom} photos can be added — the '
          'rest were ignored.',
        );
      }
    } catch (e) {
      _showMessage('Could not open the gallery: $e');
    }
  }

  /// Loads the bytes of the picked photos and updates the previews.
  Future<void> _loadBytes(List<XFile> files) async {
    for (final file in files) {
      try {
        final bytes = await file.readAsBytes();
        if (!mounted) return;
        final index = _newImages.indexWhere((p) => p.file.path == file.path);
        if (index == -1) continue;
        setState(() {
          _newImages[index] = _PickedImage(file, bytes);
        });
      } catch (e) {
        // A photo that cannot be read is simply dropped.
        if (!mounted) return;
        final index = _newImages.indexWhere((p) => p.file.path == file.path);
        if (index != -1) {
          setState(() => _newImages.removeAt(index));
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Location
  // ---------------------------------------------------------------------------

  Widget _buildLocationPicker(BuildContext context) {
    final theme = Theme.of(context);
    final hasCoordinates = _latitude != null && _longitude != null;

    return Container(
      padding: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(AppBorderRadius.md),
      ),
      child: Row(
        children: [
          Icon(
            hasCoordinates ? Icons.location_on : Icons.location_searching,
            color: theme.colorScheme.primary,
          ),
          const SizedBox(width: AppSpacing.md),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  hasCoordinates ? 'Location picked' : 'No location picked yet',
                  style: theme.textTheme.titleSmall,
                ),
                const SizedBox(height: AppSpacing.xs),
                Text(
                  hasCoordinates
                      ? '${_latitude!.toStringAsFixed(5)}, '
                            '${_longitude!.toStringAsFixed(5)}'
                      : 'Pick your current location so students can see how '
                            'far away the room is.',
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: AppSpacing.sm),
          FilledButton.tonal(
            onPressed: _isPickingLocation ? null : _pickCurrentLocation,
            child: _isPickingLocation
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Text('Pick'),
          ),
        ],
      ),
    );
  }

  Future<void> _pickCurrentLocation() async {
    setState(() => _isPickingLocation = true);
    final service = ref.read(locationServiceProvider);

    try {
      final position = await service.getCurrentPosition();
      if (!mounted) return;

      if (position == null) {
        _showMessage(
          'Could not get your location. Please turn on your location '
          'services and try again.',
        );
        return;
      }

      final placemark = await service.reverseGeocode(
        position.latitude,
        position.longitude,
      );
      if (!mounted) return;

      setState(() {
        _latitude = position.latitude;
        _longitude = position.longitude;

        final address = _firstNonEmpty([
          placemark?.street,
          placemark?.subLocality,
          placemark?.locality,
        ]);
        if (address != null) _addressController.text = address;

        final city = _firstNonEmpty([
          placemark?.locality,
          placemark?.subAdministrativeArea,
        ]);
        if (city != null) _cityController.text = city;

        final state = _firstNonEmpty([
          placemark?.administrativeArea,
          placemark?.subAdministrativeArea,
        ]);
        if (state != null) _stateController.text = state;

        final pincode = _firstNonEmpty([
          placemark?.postalCode,
          placemark?.subAdministrativeArea,
        ]);
        if (pincode != null) _pincodeController.text = pincode;
      });

      _showMessage('Location picked. Please check the address.');
    } catch (e) {
      if (!mounted) return;
      _showMessage('Could not pick your location: $e');
    } finally {
      if (mounted) setState(() => _isPickingLocation = false);
    }
  }

  static String? _firstNonEmpty(List<String?> values) {
    for (final value in values) {
      if (value != null && value.trim().isNotEmpty) return value.trim();
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Home
  // ---------------------------------------------------------------------------

  Widget _buildHomePicker(BuildContext context) {
    final theme = Theme.of(context);
    final homes = widget.homes;

    // The listing may already belong to a home that is not in the list
    // (it was deleted, or it belongs to another owner).
    final knownIds = homes.map((h) => h.id).toSet();
    final hasCurrentHome =
        _selectedHomeId != null && !knownIds.contains(_selectedHomeId);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        DropdownButtonFormField<String?>(
          initialValue: _selectedHomeId,
          decoration: const InputDecoration(labelText: 'This room belongs to'),
          items: [
            const DropdownMenuItem<String?>(
              value: null,
              child: Text('A new home'),
            ),
            ...homes.map(
              (home) => DropdownMenuItem<String?>(
                value: home.id,
                child: Text('${home.name} (${home.roomCount} rooms)'),
              ),
            ),
            if (hasCurrentHome)
              DropdownMenuItem<String?>(
                value: _selectedHomeId,
                child: Text(_homeNameFor(_selectedHomeId!) ?? 'Current home'),
              ),
          ],
          onChanged: (value) => setState(() {
            _selectedHomeId = value;
            if (value != null) {
              final name = _homeNameFor(value);
              if (name != null && _homeNameController.text.trim().isEmpty) {
                _homeNameController.text = name;
              }
            }
          }),
        ),
        const SizedBox(height: AppSpacing.sm),
        Text(
          homes.isEmpty
              ? 'Publish several rooms of the same house by giving them the '
                    'same home name.'
              : 'Pick one of your homes to add another room to it.',
          style: theme.textTheme.bodySmall?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
      ],
    );
  }

  Future<void> _pickAvailableFrom() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _availableFrom,
      firstDate: DateTime.now().subtract(const Duration(days: 365)),
      lastDate: DateTime.now().add(const Duration(days: 365 * 2)),
    );
    if (picked != null && mounted) {
      setState(() => _availableFrom = picked);
    }
  }

  void _showMessage(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(message)));
  }

  Widget _buildSectionTitle(String title) {
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.sm),
      child: Text(title, style: Theme.of(context).textTheme.titleLarge),
    );
  }

  Widget _buildDropdown<T>({
    required String label,
    required T value,
    required List<T> items,
    required ValueChanged<T?> onChanged,
    required String Function(T) getLabel,
  }) {
    return DropdownButtonFormField<T>(
      initialValue: value,
      decoration: InputDecoration(labelText: label),
      items: items
          .map((e) => DropdownMenuItem(value: e, child: Text(getLabel(e))))
          .toList(),
      onChanged: onChanged,
    );
  }

  /// The current listing status, shown as a read-only value.
  ///
  /// The status is server-owned — it is changed through the "Mark occupied" /
  /// "Mark available" action on the "My rooms" screen, which calls
  /// `setRoomListingAvailability`.
  Widget _buildReadOnlyStatus(RoomStatus status) {
    return InputDecorator(
      decoration: const InputDecoration(labelText: 'Status'),
      child: Row(
        children: [
          Expanded(child: Text(status.label)),
          const Icon(Icons.lock_outline, size: 16),
          const SizedBox(width: AppSpacing.xs),
          Text(
            'changed from "My rooms"',
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ],
      ),
    );
  }

  Widget _buildAmenitiesSelector() {
    return Wrap(
      spacing: AppSpacing.sm,
      runSpacing: AppSpacing.sm,
      children: AppConstants.amenities.map((amenity) {
        final selected = _amenities.contains(amenity);
        return AppFilterChip(
          label: amenity,
          selected: selected,
          onTap: () => setState(() {
            if (selected) {
              _amenities.remove(amenity);
            } else {
              _amenities.add(amenity);
            }
          }),
        );
      }).toList(),
    );
  }
}

/// A photo the owner just picked.
///
/// The bytes are kept in memory so the preview can be shown without reading
/// the file again — and so the form works on every platform.
class _PickedImage {
  final XFile file;
  final Uint8List bytes;

  const _PickedImage(this.file, this.bytes);
}
