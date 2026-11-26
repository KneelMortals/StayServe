import 'package:cloud_functions/cloud_functions.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

final cloudFunctionsProvider = Provider<FirebaseFunctions>(
  (ref) => FirebaseFunctions.instance,
);

final functionsServiceProvider = Provider<FunctionsService>((ref) {
  return FunctionsService(ref.watch(cloudFunctionsProvider));
});

class FunctionsService {
  final FirebaseFunctions _functions;

  FunctionsService(this._functions);

  /// Calls a callable Cloud Function by name.
  ///
  /// Every money-moving operation lives in its own repository (see
  /// `payment_repository.dart`) rather than here, so that the amount, the
  /// payee and the verification state always stay under server control.
  Future<HttpsCallableResult> callFunction(
    String name, {
    Map<String, dynamic>? parameters,
  }) async {
    final callable = _functions.httpsCallable(name);
    return await callable.call(parameters);
  }

  /// Calls a callable and returns its response as a JSON object.
  ///
  /// Repositories which need response fields use this instead of accepting an
  /// arbitrary payload shape. It also keeps the transport detail out of the
  /// repositories and makes their fail-closed validation directly testable.
  Future<Map<String, dynamic>> callFunctionData(
    String name, {
    Map<String, dynamic>? parameters,
  }) async {
    final result = await callFunction(name, parameters: parameters);
    final data = result.data;
    if (data is! Map) {
      throw StateError('The server returned an invalid response.');
    }
    return Map<String, dynamic>.from(data);
  }

  /// Calls a callable that has no result the caller needs.
  ///
  /// Callable failures are converted into a normal [Exception] carrying the
  /// server's readable message. Screens can therefore show the real reason
  /// (for example "This room still has occupants") instead of the technical
  /// Firebase exception text.
  Future<void> callVoidFunction(
    String name, {
    required Map<String, dynamic> parameters,
    required String fallbackMessage,
  }) async {
    try {
      await callFunction(name, parameters: parameters);
    } on FirebaseFunctionsException catch (error) {
      final message = error.message?.trim();
      throw Exception(
        message == null || message.isEmpty ? fallbackMessage : message,
      );
    }
  }
}
