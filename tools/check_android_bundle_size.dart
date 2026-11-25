import 'dart:convert';
import 'dart:io';

const defaultAndroidDownloadLimitBytes = 40000000;

int parseBundletoolMaxBytes(String csvOutput) {
  final lines = const LineSplitter().convert(csvOutput);
  if (lines.isEmpty) {
    throw ArgumentError.value(csvOutput, 'csvOutput', 'must not be empty');
  }
  if (lines.first != 'MIN,MAX') {
    throw const FormatException(
      'Bundletool size output must start with the MIN,MAX header.',
    );
  }
  if (lines.length < 2) {
    throw const FormatException(
      'Bundletool size output must contain at least one size row.',
    );
  }

  var maximumBytes = -1;
  for (var index = 1; index < lines.length; index += 1) {
    final columns = lines[index].split(',');
    if (columns.length != 2) {
      throw FormatException(
        'Bundletool size row ${index + 1} must contain exactly two columns.',
      );
    }

    final minimumBytes = _parseNonNegativeInteger(columns[0]);
    final rowMaximumBytes = _parseNonNegativeInteger(columns[1]);
    if (minimumBytes == null || rowMaximumBytes == null) {
      throw FormatException(
        'Bundletool size row ${index + 1} must contain non-negative integers.',
      );
    }
    if (minimumBytes > rowMaximumBytes) {
      throw FormatException(
        'Bundletool size row ${index + 1} has MIN greater than MAX.',
      );
    }
    if (rowMaximumBytes > maximumBytes) {
      maximumBytes = rowMaximumBytes;
    }
  }

  return maximumBytes;
}

int validateBundletoolSize(
  String csvOutput, {
  int limitBytes = defaultAndroidDownloadLimitBytes,
}) {
  final maximumBytes = parseBundletoolMaxBytes(csvOutput);
  if (maximumBytes >= limitBytes) {
    throw ArgumentError.value(
      maximumBytes,
      'maximumBytes',
      'must be strictly below $limitBytes',
    );
  }
  return maximumBytes;
}

int? _parseNonNegativeInteger(String value) {
  if (!RegExp(r'^\d+$').hasMatch(value)) {
    return null;
  }
  return int.tryParse(value);
}

Future<void> main(List<String> arguments) async {
  if (arguments.length != 2 || arguments.first != '--max-bytes') {
    _printUsage();
    exitCode = 64;
    return;
  }

  final limitBytes = int.tryParse(arguments[1]);
  if (limitBytes == null || limitBytes <= 0) {
    stderr.writeln('--max-bytes must be a positive integer.');
    exitCode = 64;
    return;
  }

  final csvOutput = await stdin.transform(utf8.decoder).join();
  try {
    final maximumBytes = validateBundletoolSize(
      csvOutput,
      limitBytes: limitBytes,
    );
    stdout.writeln(
      'Maximum estimated Android device download: $maximumBytes bytes',
    );
  } on ArgumentError catch (error) {
    stderr.writeln('Android bundle size validation failed: ${error.message}');
    exitCode = 1;
  } on FormatException catch (error) {
    stderr.writeln('Android bundle size validation failed: ${error.message}');
    exitCode = 1;
  }
}

void _printUsage() {
  stderr.writeln(
    'Usage: dart run tools/check_android_bundle_size.dart '
    '--max-bytes <limit>',
  );
}
