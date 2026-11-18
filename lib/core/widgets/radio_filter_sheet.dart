import 'package:material_ui/material_ui.dart';

import '../theme/app_theme.dart';

/// A modal bottom sheet that lets the user pick exactly one value from a
/// list of options and hands the selection back to the caller.
///
/// Uses the modern [RadioGroup] API (Flutter 3.32+) rather than the
/// deprecated `Radio.groupValue` / `Radio.onChanged` pair.
class RadioFilterSheet<T> extends StatefulWidget {
  const RadioFilterSheet({
    super.key,
    required this.title,
    required this.options,
    required this.labelBuilder,
    this.allLabel,
    this.initialValue,
  });

  /// Heading shown at the top of the sheet.
  final String title;

  /// The selectable options.
  final List<T> options;

  /// Builds the label rendered for each option.
  final String Function(T option) labelBuilder;

  /// When provided, an extra "show everything" entry is rendered. Selecting
  /// it resolves to `null`.
  final String? allLabel;

  /// The option that is pre-selected when the sheet opens.
  final T? initialValue;

  /// Opens the sheet and resolves to the chosen option, or `null` when the
  /// "all" entry was picked or the sheet was dismissed.
  static Future<T?> show<T>(
    BuildContext context, {
    required String title,
    required List<T> options,
    required String Function(T option) labelBuilder,
    String? allLabel,
    T? initialValue,
  }) {
    return showModalBottomSheet<T>(
      context: context,
      builder: (_) => RadioFilterSheet<T>(
        title: title,
        options: options,
        labelBuilder: labelBuilder,
        allLabel: allLabel,
        initialValue: initialValue,
      ),
    );
  }

  @override
  State<RadioFilterSheet<T>> createState() => _RadioFilterSheetState<T>();
}

class _RadioFilterSheetState<T> extends State<RadioFilterSheet<T>> {
  T? _selected;

  @override
  void initState() {
    super.initState();
    _selected = widget.initialValue;
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              widget.title,
              style: Theme.of(context).textTheme.titleLarge,
            ),
            const SizedBox(height: AppSpacing.md),
            RadioGroup<T?>(
              groupValue: _selected,
              onChanged: (value) {
                setState(() => _selected = value);
                Navigator.of(context).pop(value);
              },
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  ...widget.options.map(
                    (option) => ListTile(
                      title: Text(widget.labelBuilder(option)),
                      leading: Radio<T?>(value: option),
                      onTap: () => Navigator.of(context).pop(option),
                    ),
                  ),
                  if (widget.allLabel != null)
                    ListTile(
                      title: Text(widget.allLabel!),
                      leading: Radio<T?>(value: null),
                      onTap: () => Navigator.of(context).pop(),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
