/// The data of one Firestore document, with its id for diagnostics.
typedef DocumentData = ({String id, Map<String, dynamic> data});

/// Parses Firestore documents independently so one malformed row cannot
/// discard every valid row in the same snapshot.
///
/// The parser is deliberately allowed to throw. Callers use that behaviour
/// for model validation which cannot be expressed by a type-safe default.
List<T> parseDocumentsSafely<T>(
  Iterable<DocumentData> documents,
  T Function(String id, Map<String, dynamic> data) parser, {
  void Function(String id, Object error)? onError,
}) {
  final parsed = <T>[];

  for (final document in documents) {
    try {
      parsed.add(parser(document.id, document.data));
    } catch (error) {
      onError?.call(document.id, error);
    }
  }

  return parsed;
}
