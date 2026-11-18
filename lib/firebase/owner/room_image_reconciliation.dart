/// The result of reconciling a stale room-photo form with the live room.
class RoomImageReconciliation {
  /// The complete image list which should be written to Firestore.
  final List<String> images;

  /// The live images which the owner explicitly removed in this edit.
  final List<String> removed;

  const RoomImageReconciliation({required this.images, required this.removed});
}

/// Reconciles the photos in an owner edit with the current Firestore state.
///
/// The form may have been open while another device changed the same room.
/// The original list tells us which photos the owner explicitly removed; a
/// photo which appeared after the form was opened was never part of that
/// decision and must be preserved.
///
/// Only URLs which are still present in [currentImages] are retained. A URL
/// which another edit already removed is never restored from the stale form.
RoomImageReconciliation reconcileRoomImages({
  required List<String> currentImages,
  required List<String> originalImages,
  required List<String> draftImages,
  required List<String> uploadedImages,
}) {
  final current = _uniqueNonEmpty(currentImages);
  final draft = _uniqueNonEmpty(draftImages);
  final original = _uniqueNonEmpty(originalImages);
  final uploaded = _uniqueNonEmpty(uploadedImages);

  final explicitlyRemoved = original.toSet().difference(draft.toSet());
  final retained = current
      .where((url) => !explicitlyRemoved.contains(url))
      .toList(growable: false);
  final images = <String>[...retained];

  for (final url in uploaded) {
    if (!images.contains(url)) images.add(url);
  }

  final removed = current
      .where((url) => explicitlyRemoved.contains(url))
      .toList(growable: false);

  return RoomImageReconciliation(images: images, removed: removed);
}

List<String> _uniqueNonEmpty(Iterable<String> values) {
  final result = <String>[];
  for (final value in values) {
    final trimmed = value.trim();
    if (trimmed.isEmpty || result.contains(trimmed)) continue;
    result.add(trimmed);
  }
  return result;
}
