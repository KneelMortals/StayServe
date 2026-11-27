import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:crop_your_image/crop_your_image.dart';
import 'package:flutter/foundation.dart' show compute;
import 'package:image/image.dart' as img;
import 'package:material_ui/material_ui.dart';

import '../../../../core/index.dart';

/// The largest edge of an uploaded profile picture.
///
/// The picture is shown in a circle on the profile, so a square of this size
/// is enough for every screen of the app. The limit keeps the upload small
/// enough for a slow mobile connection.
const int kProfilePictureMaxEdge = 1024;

/// The quality of the JPEG which is uploaded.
const int kProfilePictureJpegQuality = 85;

/// Whether the bytes are a picture which the cropper can read.
///
/// The cropper decodes the picture with the `image` package, which knows
/// JPEG, PNG, WebP, GIF and BMP. A modern phone can also store HEIF photos,
/// which the platform itself can display but which the cropper cannot read.
/// Such a photo is converted by the platform first — see
/// [convertUnsupportedPicture].
bool isCroppablePicture(Uint8List bytes) {
  if (bytes.length < 4) return false;
  if (bytes[0] == 0xff && bytes[1] == 0xd8 && bytes[2] == 0xff) return true;
  if (bytes[0] == 0x89 &&
      bytes[1] == 0x50 &&
      bytes[2] == 0x4e &&
      bytes[3] == 0x47) {
    return true;
  }
  if (bytes[0] == 0x47 && bytes[1] == 0x49 && bytes[2] == 0x46) return true;
  if (bytes[0] == 0x42 && bytes[1] == 0x4d) return true;
  if (bytes.length >= 12 &&
      bytes[0] == 0x52 &&
      bytes[1] == 0x49 &&
      bytes[2] == 0x46 &&
      bytes[3] == 0x46 &&
      bytes[8] == 0x57 &&
      bytes[9] == 0x45 &&
      bytes[10] == 0x42 &&
      bytes[11] == 0x50) {
    return true;
  }
  return false;
}

/// Converts a picture which the cropper cannot read into a PNG.
///
/// The platform image decoder of the phone understands the modern formats
/// (HEIF for example), so the picture is decoded by the platform and written
/// again as a PNG which every decoder can read. `null` is returned when the
/// platform cannot decode the picture either.
Future<Uint8List?> convertUnsupportedPicture(Uint8List bytes) async {
  ui.Codec? codec;
  try {
    codec = await ui.instantiateImageCodec(bytes, targetWidth: 2048);
  } catch (error) {
    return null;
  }
  try {
    final ui.FrameInfo frame = await codec.getNextFrame();
    final ByteData? data = await frame.image.toByteData(
      format: ui.ImageByteFormat.png,
    );
    frame.image.dispose();
    if (data == null) return null;
    return data.buffer.asUint8List();
  } catch (error) {
    return null;
  } finally {
    codec.dispose();
  }
}

/// Turns a cropped picture into a small JPEG.
///
/// The cropper keeps the format of the source picture, which can be a PNG.
/// A PNG is lossless and therefore far too large for a profile picture.
/// Every phone and every browser can display a JPEG, and the server accepts
/// it as well, so the cropped picture is re-encoded before it is uploaded.
///
/// The result is always a valid JPEG: a picture which cannot be decoded
/// never reaches the server, and the user gets a readable message instead of
/// a technical error.
Future<Uint8List> encodeProfilePicture(Uint8List croppedBytes) async {
  img.Image? decoded;
  try {
    decoded = img.decodeImage(croppedBytes);
  } catch (error) {
    throw StateError('The selected photo could not be read.');
  }
  if (decoded == null) {
    throw StateError('The selected photo could not be read.');
  }

  final int longestEdge = decoded.width > decoded.height
      ? decoded.width
      : decoded.height;
  final img.Image resized = longestEdge > kProfilePictureMaxEdge
      ? img.copyResize(
          decoded,
          width: decoded.width >= decoded.height
              ? kProfilePictureMaxEdge
              : null,
          height: decoded.height > decoded.width
              ? kProfilePictureMaxEdge
              : null,
          interpolation: img.Interpolation.average,
        )
      : decoded;

  final Uint8List jpeg = img.encodeJpg(
    resized,
    quality: kProfilePictureJpegQuality,
  );
  if (jpeg.isEmpty) {
    throw StateError('The selected photo could not be prepared.');
  }
  return jpeg;
}

/// Lets the user crop the photo which was picked from the gallery.
///
/// The screen returns the cropped picture as a JPEG, or `null` when the user
/// cancelled the crop.
class ProfilePictureCropper extends StatefulWidget {
  const ProfilePictureCropper({super.key, required this.bytes});

  /// The bytes of the picked photo.
  final Uint8List bytes;

  @override
  State<ProfilePictureCropper> createState() => _ProfilePictureCropperState();
}

class _ProfilePictureCropperState extends State<ProfilePictureCropper> {
  final CropController _controller = CropController();

  Uint8List? _picture;
  bool _isPreparing = true;
  bool _isCropping = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _prepare();
  }

  /// Makes sure that the cropper receives a picture it can read.
  Future<void> _prepare() async {
    Uint8List? picture = widget.bytes;
    if (!isCroppablePicture(widget.bytes)) {
      picture = await convertUnsupportedPicture(widget.bytes);
    }
    if (!mounted) return;
    setState(() {
      _picture = picture;
      _isPreparing = false;
      if (picture == null) {
        _error =
            'This photo format is not supported. Please choose a JPEG or PNG '
            'photo.';
      }
    });
  }

  /// Starts the crop. The result arrives through [Crop.onCropped].
  void _crop() {
    if (_isCropping) return;
    setState(() {
      _isCropping = true;
      _error = null;
    });
    _controller.crop();
  }

  Future<void> _handleCropped(CropResult result) async {
    if (result is CropFailure) {
      if (!mounted) return;
      setState(() {
        _isCropping = false;
        _error = 'The selected photo could not be cropped.';
      });
      return;
    }
    if (result is! CropSuccess) return;

    Uint8List jpeg;
    try {
      // Decoding and re-encoding a picture is slow. It runs in a background
      // isolate so the screen does not freeze while it works.
      jpeg = await compute(encodeProfilePicture, result.croppedImage);
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _isCropping = false;
        _error = error is StateError
            ? error.message
            : 'The selected photo could not be prepared.';
      });
      return;
    }
    if (!mounted) return;
    Navigator.of(context).pop(jpeg);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final picture = _picture;

    return Scaffold(
      appBar: AppBar(title: const Text('Crop picture')),
      body: Column(
        children: [
          Expanded(
            child: ColoredBox(
              color: theme.colorScheme.surfaceContainerHighest,
              child: Center(
                child: AspectRatio(
                  aspectRatio: 1,
                  child: _isPreparing
                      ? const Center(child: CircularProgressIndicator())
                      : picture == null
                      ? const SizedBox.shrink()
                      : Crop(
                          image: picture,
                          controller: _controller,
                          // A profile picture is a circle, so the crop is a
                          // square which covers as much as possible.
                          withCircleUi: true,
                          radius: 9999,
                          initialRectBuilder:
                              InitialRectBuilder.withSizeAndRatio(
                                size: 1,
                                aspectRatio: 1,
                              ),
                          onCropped: _handleCropped,
                        ),
                ),
              ),
            ),
          ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(
                AppSpacing.md,
                AppSpacing.sm,
                AppSpacing.md,
                0,
              ),
              child: Text(
                _error!,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.error,
                ),
                textAlign: TextAlign.center,
              ),
            ),
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(AppSpacing.md),
              child: Row(
                children: [
                  Expanded(
                    child: AppButton(
                      label: 'Cancel',
                      type: ButtonType.secondary,
                      onPressed: _isCropping
                          ? null
                          : () => Navigator.of(context).pop(),
                    ),
                  ),
                  const SizedBox(width: AppSpacing.md),
                  Expanded(
                    child: AppButton(
                      label: 'Use photo',
                      isLoading: _isCropping,
                      onPressed: _isCropping || picture == null ? null : _crop,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
