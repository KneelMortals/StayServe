import 'package:cached_network_image/cached_network_image.dart';
import 'package:material_ui/material_ui.dart';
import 'package:photo_view/photo_view.dart';
import 'package:photo_view/photo_view_gallery.dart';

/// A full-screen, zoomable viewer for the photos attached to a room.
///
/// Room photos are stored as opaque Firebase Storage download URLs. They
/// must be passed through unchanged because their access token is part of
/// the URL.
class RoomImageViewer extends StatefulWidget {
  final List<String> imageUrls;
  final int initialIndex;

  const RoomImageViewer({
    required this.imageUrls,
    this.initialIndex = 0,
    super.key,
  });

  /// Opens the viewer over the current route.
  static Future<void> show(
    BuildContext context, {
    required List<String> imageUrls,
    int initialIndex = 0,
  }) {
    if (imageUrls.isEmpty) return Future<void>.value();

    final safeIndex = initialIndex.clamp(0, imageUrls.length - 1).toInt();
    // GoRouter's shell routes use nested navigators and keep their bottom
    // navigation (or the admin's wide-screen rail) outside the child
    // navigator. Push on the root navigator so the photo really covers the
    // whole application, including that shell chrome.
    return Navigator.of(context, rootNavigator: true).push<void>(
      MaterialPageRoute<void>(
        fullscreenDialog: true,
        builder: (_) => RoomImageViewer(
          imageUrls: List<String>.unmodifiable(imageUrls),
          initialIndex: safeIndex,
        ),
      ),
    );
  }

  @override
  State<RoomImageViewer> createState() => _RoomImageViewerState();
}

class _RoomImageViewerState extends State<RoomImageViewer> {
  late final PageController _pageController;
  late int _currentIndex;

  @override
  void initState() {
    super.initState();
    _currentIndex = widget.initialIndex
        .clamp(0, widget.imageUrls.length - 1)
        .toInt();
    _pageController = PageController(initialPage: _currentIndex);
  }

  @override
  void dispose() {
    _pageController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      key: const ValueKey('room-image-viewer'),
      backgroundColor: Colors.black,
      body: Stack(
        fit: StackFit.expand,
        children: [
          PhotoViewGallery.builder(
            itemCount: widget.imageUrls.length,
            pageController: _pageController,
            onPageChanged: (index) {
              if (!mounted) return;
              setState(() => _currentIndex = index);
            },
            backgroundDecoration: const BoxDecoration(color: Colors.black),
            loadingBuilder: (context, event) => const Center(
              child: CircularProgressIndicator(color: Colors.white),
            ),
            builder: (context, index) {
              return PhotoViewGalleryPageOptions(
                imageProvider: CachedNetworkImageProvider(
                  widget.imageUrls[index],
                ),
                minScale: PhotoViewComputedScale.contained,
                maxScale: PhotoViewComputedScale.covered * 3,
                initialScale: PhotoViewComputedScale.contained,
                semanticLabel:
                    'Room photo ${index + 1} of ${widget.imageUrls.length}',
                errorBuilder: (context, error, stackTrace) => const Center(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(
                        Icons.broken_image_outlined,
                        color: Colors.white,
                        size: 56,
                      ),
                      SizedBox(height: 12),
                      Text(
                        'This photo could not be loaded.',
                        style: TextStyle(color: Colors.white),
                      ),
                    ],
                  ),
                ),
              );
            },
          ),
          Positioned(
            top: 0,
            right: 0,
            child: SafeArea(
              child: IconButton(
                key: const ValueKey('room-image-viewer-close'),
                tooltip: 'Close photo',
                onPressed: () =>
                    Navigator.of(context, rootNavigator: true).pop(),
                icon: const Icon(Icons.close, color: Colors.white),
              ),
            ),
          ),
          if (widget.imageUrls.length > 1)
            Positioned(
              left: 0,
              right: 0,
              bottom: 0,
              child: SafeArea(
                child: Padding(
                  padding: const EdgeInsets.only(bottom: 16),
                  child: Text(
                    '${_currentIndex + 1} / ${widget.imageUrls.length}',
                    key: const ValueKey('room-image-viewer-page-count'),
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                      color: Colors.white,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
