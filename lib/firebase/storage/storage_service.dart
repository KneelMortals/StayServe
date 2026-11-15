import 'dart:typed_data';

import 'package:firebase_storage/firebase_storage.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

final firebaseStorageProvider = Provider<FirebaseStorage>((ref) => FirebaseStorage.instance);

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

  Future<void> deleteFile(String url) async {
    try {
      final ref = _storage.refFromURL(url);
      await ref.delete();
    } catch (e) {
      // Ignore if file doesn't exist
    }
  }

  Future<void> deleteFiles(List<String> urls) async {
    await Future.wait(urls.map(deleteFile));
  }

  Reference getRef(String path) => _storage.ref().child(path);
}