import 'dart:typed_data';

import 'package:firebase_storage/firebase_storage.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

final firebaseStorageProvider = Provider<FirebaseStorage>(
  (ref) => FirebaseStorage.instance,
);

final storageServiceProvider = Provider<StorageService>((ref) {
  return StorageService(ref.watch(firebaseStorageProvider));
});

class StorageService {
  final FirebaseStorage _storage;

  StorageService(this._storage);

  Future<String> uploadFile({
    required String path,
    required String fileName,
    required List<int> bytes,
    String contentType = 'image/jpeg',
  }) async {
    final ref = _storage.ref().child('$path/$fileName');
    final metadata = SettableMetadata(contentType: contentType);
    final task = await ref.putData(Uint8List.fromList(bytes), metadata);
    return await task.ref.getDownloadURL();
  }

  Future<String> uploadImage({
    required String path,
    required String fileName,
    required List<int> bytes,
  }) async {
    return uploadFile(
      path: path,
      fileName: fileName,
      bytes: bytes,
      contentType: 'image/jpeg',
    );
  }

  /// Deletes one object and reports whether the deletion succeeded.
  ///
  /// The caller uses the result to distinguish a missing object from a real
  /// Storage failure. A failed cleanup is logged, but it must never make a
  /// successful Firestore update look like it failed.
  Future<bool> deleteFile(String url) async {
    try {
      final ref = _storage.refFromURL(url);
      await ref.delete();
      return true;
    } on FirebaseException catch (error) {
      // The desired end state already exists when the object is gone.
      if (error.code == 'object-not-found') return true;
      return false;
    } catch (_) {
      return false;
    }
  }

  /// Deletes an object by its Storage path.
  ///
  /// This is used while rolling back an upload. The path is known before the
  /// upload starts, so an object can still be removed when the upload itself
  /// succeeded but fetching its download URL failed.
  Future<bool> deleteFileAtPath(String path) async {
    try {
      await _storage.ref().child(path).delete();
      return true;
    } on FirebaseException catch (error) {
      if (error.code == 'object-not-found') return true;
      return false;
    } catch (_) {
      return false;
    }
  }

  /// Deletes the objects and returns the URLs which could not be removed.
  Future<List<String>> deleteFiles(List<String> urls) async {
    final results = await Future.wait(urls.map(deleteFile));
    final failed = <String>[];
    for (var index = 0; index < urls.length; index++) {
      if (!results[index]) failed.add(urls[index]);
    }
    return failed;
  }

  /// Deletes objects by path and returns the paths which could not be removed.
  Future<List<String>> deleteFilesAtPaths(List<String> paths) async {
    final results = await Future.wait(paths.map(deleteFileAtPath));
    final failed = <String>[];
    for (var index = 0; index < paths.length; index++) {
      if (!results[index]) failed.add(paths[index]);
    }
    return failed;
  }

  Reference getRef(String path) => _storage.ref().child(path);
}
