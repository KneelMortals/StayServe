import 'package:material_ui/material_ui.dart';
import 'package:cached_network_image/cached_network_image.dart';

import '../theme/app_theme.dart';
import '../utils/validators.dart';

class AppButton extends StatelessWidget {
  final String label;
  final VoidCallback? onPressed;
  final bool isLoading;
  final bool isFullWidth;
  final ButtonStyle? style;
  final Widget? icon;
  final ButtonType type;

  const AppButton({
    required this.label,
    this.onPressed,
    this.isLoading = false,
    this.isFullWidth = true,
    this.style,
    this.icon,
    this.type = ButtonType.primary,
    super.key,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isDisabled = onPressed == null || isLoading;

    Widget child = isLoading
        ? SizedBox(
            height: 20,
            width: 20,
            child: CircularProgressIndicator(
              strokeWidth: 2,
              valueColor: AlwaysStoppedAnimation<Color>(
                type == ButtonType.primary ? theme.colorScheme.onPrimary : theme.colorScheme.primary,
              ),
            ),
          )
        : Row(
            mainAxisSize: isFullWidth ? MainAxisSize.max : MainAxisSize.min,
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              if (icon != null) ...[icon!, const SizedBox(width: 8)],
              // The label is flexible and may use a second line: a long label
              // ("Continue with Google") used to be drawn outside of the
              // button, which is what made the words and the boxes overlap.
              // A second line is better than a cut word, and the button grows
              // with it.
              Flexible(
                child: Text(
                  label,
                  style: theme.textTheme.labelLarge,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  textAlign: TextAlign.center,
                ),
              ),
            ],
          );

    switch (type) {
      case ButtonType.primary:
        return SizedBox(
          width: isFullWidth ? double.infinity : null,
          child: ElevatedButton(
            onPressed: isDisabled ? null : onPressed,
            style: style,
            child: child,
          ),
        );
      case ButtonType.secondary:
        return SizedBox(
          width: isFullWidth ? double.infinity : null,
          child: OutlinedButton(
            onPressed: isDisabled ? null : onPressed,
            style: style,
            child: child,
          ),
        );
      case ButtonType.text:
        return SizedBox(
          width: isFullWidth ? double.infinity : null,
          child: TextButton(
            onPressed: isDisabled ? null : onPressed,
            style: style,
            child: child,
          ),
        );
      case ButtonType.danger:
        return SizedBox(
          width: isFullWidth ? double.infinity : null,
          child: ElevatedButton(
            onPressed: isDisabled ? null : onPressed,
            style: style ?? ElevatedButton.styleFrom(
              backgroundColor: theme.colorScheme.error,
              foregroundColor: theme.colorScheme.onError,
            ),
            child: child,
          ),
        );
    }
  }
}

enum ButtonType { primary, secondary, text, danger }

class AppTextField extends StatelessWidget {
  final String? label;
  final String? hint;
  final TextEditingController? controller;
  final String? initialValue;
  final bool obscureText;
  final TextInputType keyboardType;
  final TextInputAction textInputAction;
  final String? Function(String?)? validator;
  final void Function(String)? onChanged;
  final void Function(String)? onFieldSubmitted;
  final Widget? prefixIcon;
  final Widget? suffixIcon;
  final int? maxLines;
  final int? maxLength;
  final bool enabled;
  final bool readOnly;
  final VoidCallback? onTap;
  final FocusNode? focusNode;
  final TextCapitalization textCapitalization;

  const AppTextField({
    this.label,
    this.hint,
    this.controller,
    this.initialValue,
    this.obscureText = false,
    this.keyboardType = TextInputType.text,
    this.textInputAction = TextInputAction.next,
    this.validator,
    this.onChanged,
    this.onFieldSubmitted,
    this.prefixIcon,
    this.suffixIcon,
    this.maxLines = 1,
    this.maxLength,
    this.enabled = true,
    this.readOnly = false,
    this.onTap,
    this.focusNode,
    this.textCapitalization = TextCapitalization.none,
    super.key,
  });

  @override
  Widget build(BuildContext context) {
    return TextFormField(
      controller: controller,
      initialValue: initialValue,
      obscureText: obscureText,
      keyboardType: keyboardType,
      textInputAction: textInputAction,
      validator: validator,
      onChanged: onChanged,
      onFieldSubmitted: onFieldSubmitted,
      maxLines: maxLines,
      maxLength: maxLength,
      enabled: enabled,
      readOnly: readOnly,
      onTap: onTap,
      focusNode: focusNode,
      textCapitalization: textCapitalization,
      decoration: InputDecoration(
        labelText: label,
        hintText: hint,
        prefixIcon: prefixIcon,
        suffixIcon: suffixIcon,
        counterText: maxLength != null ? '' : null,
      ),
    );
  }
}

class AppCard extends StatelessWidget {
  final Widget child;
  final EdgeInsetsGeometry? padding;
  final EdgeInsetsGeometry? margin;
  final VoidCallback? onTap;
  final Color? color;
  final List<BoxShadow>? shadows;
  final BorderRadius? borderRadius;
  final Border? border;

  const AppCard({
    required this.child,
    this.padding,
    this.margin,
    this.onTap,
    this.color,
    this.shadows,
    this.borderRadius,
    this.border,
    super.key,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final card = Container(
      padding: padding ?? const EdgeInsets.all(AppSpacing.md),
      margin: margin ?? const EdgeInsets.all(AppSpacing.sm),
      decoration: BoxDecoration(
        color: color ?? theme.cardColor,
        borderRadius: borderRadius ?? BorderRadius.circular(AppBorderRadius.lg),
        boxShadow: shadows ?? AppShadows.level1,
        border: border ?? Border.all(color: theme.dividerColor),
      ),
      child: child,
    );

    if (onTap != null) {
      return InkWell(
        onTap: onTap,
        borderRadius: borderRadius ?? BorderRadius.circular(AppBorderRadius.lg),
        child: card,
      );
    }
    return card;
  }
}

class AppImage extends StatelessWidget {
  final String? imageUrl;
  final double? width;
  final double? height;
  final BoxFit fit;
  final BorderRadius? borderRadius;
  final Widget? placeholder;
  final Widget? errorWidget;
  final VoidCallback? onTap;

  const AppImage({
    this.imageUrl,
    this.width,
    this.height,
    this.fit = BoxFit.cover,
    this.borderRadius,
    this.placeholder,
    this.errorWidget,
    this.onTap,
    super.key,
  });

  @override
  Widget build(BuildContext context) {
    if (imageUrl == null || imageUrl!.isEmpty) {
      return _buildPlaceholder(context);
    }

    final image = CachedNetworkImage(
      imageUrl: imageUrl!,
      width: width,
      height: height,
      fit: fit,
      placeholder: (context, url) => placeholder ?? _buildPlaceholder(context),
      errorWidget: (context, url, error) => errorWidget ?? _buildError(context),
    );

    final clippedImage = borderRadius != null
        ? ClipRRect(borderRadius: borderRadius!, child: image)
        : image;
    if (onTap == null) return clippedImage;

    return Semantics(
      button: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: clippedImage,
      ),
    );
  }

  Widget _buildPlaceholder(BuildContext context) {
    // A spinner that never stops: the placeholder was shown for every room
    // without a photo, and the "loading" indicator just kept spinning
    // forever.
    return Container(
      width: width,
      height: height,
      color: Theme.of(context).colorScheme.surfaceContainerHighest,
      child: Icon(
        Icons.image_outlined,
        color: Theme.of(context).colorScheme.onSurfaceVariant,
        size: 40,
      ),
    );
  }

  Widget _buildError(BuildContext context) {
    return Container(
      width: width,
      height: height,
      color: Theme.of(context).colorScheme.surfaceContainerHighest,
      child: Icon(
        Icons.image_not_supported,
        color: Theme.of(context).colorScheme.onSurfaceVariant,
        size: 48,
      ),
    );
  }
}

class AppAvatar extends StatelessWidget {
  final String? imageUrl;
  final String? name;
  final double radius;
  final Color? backgroundColor;
  final TextStyle? textStyle;

  const AppAvatar({
    this.imageUrl,
    this.name,
    this.radius = 20,
    this.backgroundColor,
    this.textStyle,
    super.key,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final bgColor = backgroundColor ?? theme.colorScheme.primaryContainer;

    if (imageUrl != null && imageUrl!.isNotEmpty) {
      return CircleAvatar(
        radius: radius,
        backgroundImage: CachedNetworkImageProvider(imageUrl!),
        backgroundColor: bgColor,
      );
    }

    return CircleAvatar(
      radius: radius,
      backgroundColor: bgColor,
      child: Text(
        name != null ? AppHelpers.getInitials(name!) : '?',
        style: textStyle ?? theme.textTheme.titleMedium?.copyWith(
          color: theme.colorScheme.onPrimaryContainer,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}

class EmptyState extends StatelessWidget {
  final IconData icon;
  final String title;
  final String message;
  final String? actionLabel;
  final VoidCallback? onAction;

  const EmptyState({
    required this.icon,
    required this.title,
    required this.message,
    this.actionLabel,
    this.onAction,
    super.key,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.xl),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Container(
              padding: const EdgeInsets.all(AppSpacing.xl),
              decoration: BoxDecoration(
                color: theme.colorScheme.primaryContainer.withValues(alpha: 0.3),
                shape: BoxShape.circle,
              ),
              child: Icon(
                icon,
                size: 64,
                color: theme.colorScheme.primary,
              ),
            ),
            const SizedBox(height: AppSpacing.lg),
            Text(
              title,
              style: theme.textTheme.headlineSmall,
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: AppSpacing.sm),
            Text(
              message,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
              textAlign: TextAlign.center,
            ),
            if (actionLabel != null && onAction != null) ...[
              const SizedBox(height: AppSpacing.lg),
              AppButton(
                label: actionLabel!,
                onPressed: onAction,
                isFullWidth: false,
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class LoadingOverlay extends StatelessWidget {
  final bool isLoading;
  final Widget child;
  final String? message;

  const LoadingOverlay({
    required this.isLoading,
    required this.child,
    this.message,
    super.key,
  });

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: [
        child,
        if (isLoading)
          Container(
            color: Colors.black.withValues(alpha: 0.3),
            child: Center(
              child: Container(
                padding: const EdgeInsets.all(AppSpacing.xl),
                decoration: BoxDecoration(
                  color: Theme.of(context).colorScheme.surface,
                  borderRadius: BorderRadius.circular(AppBorderRadius.lg),
                ),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const CircularProgressIndicator(),
                    if (message != null) ...[
                      const SizedBox(height: AppSpacing.md),
                      Text(message!, style: Theme.of(context).textTheme.bodyMedium),
                    ],
                  ],
                ),
              ),
            ),
          ),
      ],
    );
  }
}

class ErrorBanner extends StatelessWidget {
  final String message;
  final VoidCallback? onDismiss;
  final VoidCallback? onRetry;

  const ErrorBanner({
    required this.message,
    this.onDismiss,
    this.onRetry,
    super.key,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(AppSpacing.md),
      margin: const EdgeInsets.all(AppSpacing.md),
      decoration: BoxDecoration(
        color: theme.colorScheme.errorContainer,
        borderRadius: BorderRadius.circular(AppBorderRadius.md),
        border: Border.all(color: theme.colorScheme.error),
      ),
      child: Row(
        children: [
          Icon(Icons.error_outline, color: theme.colorScheme.error, size: 20),
          const SizedBox(width: AppSpacing.sm),
          Expanded(
            child: Text(
              message,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onErrorContainer,
              ),
            ),
          ),
          if (onRetry != null)
            TextButton(
              onPressed: onRetry,
              child: Text('Retry', style: TextStyle(color: theme.colorScheme.error)),
            ),
          if (onDismiss != null)
            IconButton(
              onPressed: onDismiss,
              icon: Icon(Icons.close, color: theme.colorScheme.error, size: 20),
              padding: EdgeInsets.zero,
              constraints: const BoxConstraints(),
            ),
        ],
      ),
    );
  }
}

class AppFilterChip extends StatelessWidget {
  final String label;
  final bool selected;
  final VoidCallback? onTap;
  final Widget? avatar;

  const AppFilterChip({
    required this.label,
    this.selected = false,
    this.onTap,
    this.avatar,
    super.key,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return InputChip(
      label: Text(label),
      selected: selected,
      onSelected: (_) => onTap?.call(),
      avatar: avatar,
      selectedColor: theme.colorScheme.primaryContainer,
      checkmarkColor: theme.colorScheme.primary,
      labelStyle: theme.textTheme.labelMedium?.copyWith(
        color: selected ? theme.colorScheme.primary : theme.colorScheme.onSurfaceVariant,
      ),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AppBorderRadius.full),
        side: BorderSide(
          color: selected ? theme.colorScheme.primary : theme.colorScheme.outlineVariant,
        ),
      ),
    );
  }
}

class ConfirmationDialog extends StatelessWidget {
  final String title;
  final String message;
  final String confirmLabel;
  final String cancelLabel;
  final bool isDestructive;
  final VoidCallback? onConfirm;
  final VoidCallback? onCancel;

  const ConfirmationDialog({
    required this.title,
    required this.message,
    this.confirmLabel = 'Confirm',
    this.cancelLabel = 'Cancel',
    this.isDestructive = false,
    this.onConfirm,
    this.onCancel,
    super.key,
  });

  static Future<bool?> show(
    BuildContext context, {
    required String title,
    required String message,
    String confirmLabel = 'Confirm',
    String cancelLabel = 'Cancel',
    bool isDestructive = false,
  }) {
    return showDialog<bool>(
      context: context,
      builder: (context) => ConfirmationDialog(
        title: title,
        message: message,
        confirmLabel: confirmLabel,
        cancelLabel: cancelLabel,
        isDestructive: isDestructive,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return AlertDialog(
      title: Text(title),
      content: Text(message),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(false),
          child: Text(cancelLabel),
        ),
        ElevatedButton(
          onPressed: () => Navigator.of(context).pop(true),
          style: isDestructive
              ? ElevatedButton.styleFrom(
                  backgroundColor: theme.colorScheme.error,
                  foregroundColor: theme.colorScheme.onError,
                )
              : null,
          child: Text(confirmLabel),
        ),
      ],
    );
  }
}


/// A dialog with a single text field.
///
/// It **owns** its controller and disposes it together with the dialog.
///
/// The admin screens used to create the controller in the caller, hand it
/// to a `TextField` inside a `showDialog` builder and never dispose it —
/// every dialog that was opened leaked a controller. Disposing it in the
/// caller instead is not safe either: the dialog is still on its way out
/// when `showDialog` returns, and the text field that is still mounted then
/// asks the controller for its value ("A TextEditingController was used
/// after being disposed").
class TextInputDialog extends StatefulWidget {
  final String title;
  final String label;
  final String? hint;
  final String confirmLabel;
  final String cancelLabel;
  final int maxLines;
  final bool isDestructive;

  const TextInputDialog({
    required this.title,
    required this.label,
    this.hint,
    this.confirmLabel = 'Save',
    this.cancelLabel = 'Cancel',
    this.maxLines = 3,
    this.isDestructive = false,
    super.key,
  });

  /// Shows the dialog and returns the text — `null` when it was closed.
  static Future<String?> show(
    BuildContext context, {
    required String title,
    required String label,
    String? hint,
    String confirmLabel = 'Save',
    String cancelLabel = 'Cancel',
    int maxLines = 3,
    bool isDestructive = false,
  }) {
    return showDialog<String>(
      context: context,
      builder: (context) => TextInputDialog(
        title: title,
        label: label,
        hint: hint,
        confirmLabel: confirmLabel,
        cancelLabel: cancelLabel,
        maxLines: maxLines,
        isDestructive: isDestructive,
      ),
    );
  }

  @override
  State<TextInputDialog> createState() => _TextInputDialogState();
}

class _TextInputDialogState extends State<TextInputDialog> {
  final _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return AlertDialog(
      title: Text(widget.title),
      content: TextField(
        controller: _controller,
        autofocus: true,
        maxLines: widget.maxLines,
        decoration: InputDecoration(
          labelText: widget.label,
          hintText: widget.hint,
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: Text(widget.cancelLabel),
        ),
        ElevatedButton(
          onPressed: () => Navigator.of(context).pop(_controller.text.trim()),
          style: widget.isDestructive
              ? ElevatedButton.styleFrom(
                  backgroundColor: theme.colorScheme.error,
                  foregroundColor: theme.colorScheme.onError,
                )
              : null,
          child: Text(widget.confirmLabel),
        ),
      ],
    );
  }
}
