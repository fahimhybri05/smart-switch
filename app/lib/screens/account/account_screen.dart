import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../providers/service_providers.dart';
import '../../services/backend/backend_api_exception.dart';
import '../../services/backend/backend_auth_client.dart';
import '../../services/app_shortcuts.dart';
import '../../services/widget_service.dart';
import '../../theme/spacing.dart';
import '../shared/friendly_error.dart';

/// Account management: profile summary, change email/password, sign out and
/// permanent account deletion (Google Play requires in-app deletion for apps
/// that allow sign-up). Every change is confirmed with the current password;
/// the backend enforces that too.
class AccountScreen extends ConsumerStatefulWidget {
  const AccountScreen({super.key});

  @override
  ConsumerState<AccountScreen> createState() => _AccountScreenState();
}

class _AccountScreenState extends ConsumerState<AccountScreen> {
  late Future<AccountInfo> _account = _load();

  Future<AccountInfo> _load() => ref.read(authProvider.notifier).fetchAccount();

  void _reload() => setState(() => _account = _load());

  Future<void> _logout() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Log out?'),
        content: const Text('You can sign back in any time.'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Log out'),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    Navigator.of(context).popUntil((route) => route.isFirst);
    await ref.read(authProvider.notifier).logout();
  }

  @override
  Widget build(BuildContext context) {
    final email = ref.watch(authProvider)?.email ?? '';
    final colorScheme = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(title: const Text('Account')),
      body: ListView(
        // Cards carry their own horizontal margin (same as Settings).
        padding: const EdgeInsets.only(top: Spacing.sm, bottom: Spacing.lg),
        children: [
          FutureBuilder<AccountInfo>(
            future: _account,
            builder: (context, snap) => _ProfileCard(
              email: email,
              account: snap.data,
              loading: snap.connectionState != ConnectionState.done,
              failed: snap.hasError,
              onRetry: _reload,
            ),
          ),
          const _Section('Sign-in'),
          Card(
            child: Column(
              children: [
                ListTile(
                  leading: const _IconBox(Icons.alternate_email_rounded),
                  title: const Text('Email'),
                  subtitle: Text(email),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () async {
                    final changed = await showModalBottomSheet<bool>(
                      context: context,
                      isScrollControlled: true,
                      showDragHandle: true,
                      builder: (_) => _ChangeEmailSheet(currentEmail: email),
                    );
                    if (changed == true) _reload();
                  },
                ),
                const Divider(height: 1),
                ListTile(
                  leading: const _IconBox(Icons.lock_outline_rounded),
                  title: const Text('Password'),
                  subtitle: const Text('Change the password you sign in with'),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => showModalBottomSheet<void>(
                    context: context,
                    isScrollControlled: true,
                    showDragHandle: true,
                    builder: (_) => const _ChangePasswordSheet(),
                  ),
                ),
              ],
            ),
          ),
          const _Section('Session'),
          Card(
            child: ListTile(
              leading: const _IconBox(Icons.logout_rounded),
              title: const Text('Log out'),
              subtitle: const Text('Sign out on this phone'),
              onTap: _logout,
            ),
          ),
          const _Section('Danger zone'),
          Card(
            child: ListTile(
              leading: _IconBox(
                Icons.delete_forever_outlined,
                color: colorScheme.error,
              ),
              title: Text(
                'Delete account',
                style: TextStyle(color: colorScheme.error),
              ),
              subtitle: const Text('Permanently remove your account and data'),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => const DeleteAccountScreen(),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/* ------------------------------ Profile card ------------------------------ */

class _ProfileCard extends StatelessWidget {
  const _ProfileCard({
    required this.email,
    required this.account,
    required this.loading,
    required this.failed,
    required this.onRetry,
  });

  final String email;
  final AccountInfo? account;
  final bool loading;
  final bool failed;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final created = account?.createdAt;
    final households = account?.households ?? const [];
    final details = <String>[
      if (created != null)
        'Member since ${MaterialLocalizations.of(context).formatMediumDate(created.toLocal())}',
      if (households.isNotEmpty)
        '${households.length} household${households.length == 1 ? '' : 's'}',
    ];
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(Spacing.md),
        child: Row(
          children: [
            CircleAvatar(
              radius: 28,
              backgroundColor: colorScheme.primaryContainer,
              child: Text(
                email.isEmpty ? '?' : email[0].toUpperCase(),
                style: theme.textTheme.titleLarge?.copyWith(
                  color: colorScheme.onPrimaryContainer,
                  fontWeight: FontWeight.w800,
                ),
              ),
            ),
            const SizedBox(width: Spacing.md),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    email,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(height: 2),
                  if (loading)
                    Text(
                      'Loading…',
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: colorScheme.onSurfaceVariant,
                      ),
                    )
                  else if (failed)
                    InkWell(
                      onTap: onRetry,
                      child: Text(
                        'Couldn’t load details — tap to retry',
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: colorScheme.error,
                        ),
                      ),
                    )
                  else
                    Text(
                      details.isEmpty
                          ? 'Smart Control account'
                          : details.join(' · '),
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: colorScheme.onSurfaceVariant,
                      ),
                    ),
                  if (households.isNotEmpty) ...[
                    const SizedBox(height: Spacing.sm),
                    Wrap(
                      spacing: 6,
                      runSpacing: 6,
                      children: [
                        for (final h in households)
                          Chip(
                            visualDensity: VisualDensity.compact,
                            materialTapTargetSize:
                                MaterialTapTargetSize.shrinkWrap,
                            avatar: Icon(
                              h.role == 'owner'
                                  ? Icons.star_rounded
                                  : Icons.person_outline_rounded,
                              size: 16,
                            ),
                            label: Text('${h.name} · ${h.role}'),
                          ),
                      ],
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/* --------------------------------- Sheets --------------------------------- */

/// Backend error → plain message. 403 is always "wrong password" on these
/// routes (401 would mean the session itself died).
String _accountError(Object error, String action, {String? conflict}) {
  if (error is BackendApiException) {
    switch (error.statusCode) {
      case 403:
        return 'That password is incorrect.';
      case 409:
        return conflict ?? '$action failed. Please try again.';
      case 429:
        return 'Too many attempts. Please wait 15 minutes and try again.';
      case 400:
        return 'Please check what you entered and try again.';
    }
  }
  return friendlyErrorMessage(error, action);
}

/// Common shell for the bottom-sheet forms: keyboard-aware padding, title,
/// description, fields, error line and a full-width submit button.
class _SheetForm extends StatelessWidget {
  const _SheetForm({
    required this.formKey,
    required this.title,
    required this.description,
    required this.fields,
    required this.error,
    required this.busy,
    required this.submitLabel,
    required this.onSubmit,
  });

  final GlobalKey<FormState> formKey;
  final String title;
  final String description;
  final List<Widget> fields;
  final String? error;
  final bool busy;
  final String submitLabel;
  final VoidCallback onSubmit;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: EdgeInsets.fromLTRB(
        Spacing.lg,
        0,
        Spacing.lg,
        Spacing.lg + MediaQuery.viewInsetsOf(context).bottom,
      ),
      child: Form(
        key: formKey,
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                title,
                style: theme.textTheme.titleLarge?.copyWith(
                  fontWeight: FontWeight.w800,
                ),
              ),
              const SizedBox(height: Spacing.xs),
              Text(
                description,
                style: theme.textTheme.bodyMedium?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
              const SizedBox(height: Spacing.md),
              for (final f in fields) ...[
                f,
                const SizedBox(height: Spacing.sm),
              ],
              AnimatedSize(
                duration: const Duration(milliseconds: 200),
                child: error == null
                    ? const SizedBox(width: double.infinity)
                    : Padding(
                        padding: const EdgeInsets.only(bottom: Spacing.sm),
                        child: Text(
                          error!,
                          style: TextStyle(color: theme.colorScheme.error),
                        ),
                      ),
              ),
              const SizedBox(height: Spacing.xs),
              FilledButton(
                onPressed: busy ? null : onSubmit,
                child: busy
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : Text(submitLabel),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _PasswordField extends StatefulWidget {
  const _PasswordField({
    required this.controller,
    required this.label,
    this.validator,
    this.autofillHints,
    this.textInputAction = TextInputAction.next,
    this.onSubmitted,
  });

  final TextEditingController controller;
  final String label;
  final FormFieldValidator<String>? validator;
  final Iterable<String>? autofillHints;
  final TextInputAction textInputAction;
  final ValueChanged<String>? onSubmitted;

  @override
  State<_PasswordField> createState() => _PasswordFieldState();
}

class _PasswordFieldState extends State<_PasswordField> {
  bool _obscure = true;

  @override
  Widget build(BuildContext context) {
    return TextFormField(
      controller: widget.controller,
      obscureText: _obscure,
      autofillHints: widget.autofillHints,
      textInputAction: widget.textInputAction,
      onFieldSubmitted: widget.onSubmitted,
      validator:
          widget.validator ??
          (v) => (v == null || v.isEmpty) ? 'Enter your password' : null,
      decoration: InputDecoration(
        labelText: widget.label,
        prefixIcon: const Icon(Icons.lock_outline_rounded),
        suffixIcon: IconButton(
          tooltip: _obscure ? 'Show password' : 'Hide password',
          icon: Icon(
            _obscure
                ? Icons.visibility_outlined
                : Icons.visibility_off_outlined,
          ),
          onPressed: () => setState(() => _obscure = !_obscure),
        ),
      ),
    );
  }
}

class _ChangeEmailSheet extends ConsumerStatefulWidget {
  const _ChangeEmailSheet({required this.currentEmail});

  final String currentEmail;

  @override
  ConsumerState<_ChangeEmailSheet> createState() => _ChangeEmailSheetState();
}

class _ChangeEmailSheetState extends ConsumerState<_ChangeEmailSheet> {
  final _formKey = GlobalKey<FormState>();
  final _email = TextEditingController();
  final _password = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref
          .read(authProvider.notifier)
          .changeEmail(newEmail: _email.text.trim(), password: _password.text);
      if (!mounted) return;
      final messenger = ScaffoldMessenger.of(context);
      Navigator.pop(context, true);
      messenger.showSnackBar(
        const SnackBar(
          content: Text('Email updated. Use it next time you sign in.'),
        ),
      );
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = _accountError(
          e,
          'Changing email',
          conflict: 'That email is already registered to another account.',
        );
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return _SheetForm(
      formKey: _formKey,
      title: 'Change email',
      description:
          'Currently ${widget.currentEmail}. Confirm with your password.',
      busy: _busy,
      error: _error,
      submitLabel: 'Save email',
      onSubmit: _submit,
      fields: [
        TextFormField(
          controller: _email,
          autofocus: true,
          keyboardType: TextInputType.emailAddress,
          autofillHints: const [AutofillHints.email],
          textInputAction: TextInputAction.next,
          decoration: const InputDecoration(
            labelText: 'New email',
            prefixIcon: Icon(Icons.alternate_email_rounded),
          ),
          validator: (v) {
            final value = v?.trim() ?? '';
            if (!RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$').hasMatch(value)) {
              return 'Enter a valid email address';
            }
            if (value.toLowerCase() == widget.currentEmail.toLowerCase()) {
              return 'That’s already your email';
            }
            return null;
          },
        ),
        _PasswordField(
          controller: _password,
          label: 'Current password',
          autofillHints: const [AutofillHints.password],
          textInputAction: TextInputAction.done,
          onSubmitted: (_) => _submit(),
        ),
      ],
    );
  }
}

class _ChangePasswordSheet extends ConsumerStatefulWidget {
  const _ChangePasswordSheet();

  @override
  ConsumerState<_ChangePasswordSheet> createState() =>
      _ChangePasswordSheetState();
}

class _ChangePasswordSheetState extends ConsumerState<_ChangePasswordSheet> {
  final _formKey = GlobalKey<FormState>();
  final _current = TextEditingController();
  final _next = TextEditingController();
  final _confirm = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _current.dispose();
    _next.dispose();
    _confirm.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref
          .read(authProvider.notifier)
          .changePassword(
            currentPassword: _current.text,
            newPassword: _next.text,
          );
      if (!mounted) return;
      final messenger = ScaffoldMessenger.of(context);
      Navigator.pop(context);
      messenger.showSnackBar(
        const SnackBar(
          content: Text('Password changed. Other devices were signed out.'),
        ),
      );
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = _accountError(e, 'Changing password');
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return _SheetForm(
      formKey: _formKey,
      title: 'Change password',
      description:
          'You’ll stay signed in here; other phones and browsers will be signed out.',
      busy: _busy,
      error: _error,
      submitLabel: 'Change password',
      onSubmit: _submit,
      fields: [
        _PasswordField(
          controller: _current,
          label: 'Current password',
          autofillHints: const [AutofillHints.password],
        ),
        _PasswordField(
          controller: _next,
          label: 'New password',
          autofillHints: const [AutofillHints.newPassword],
          validator: (v) {
            if (v == null || v.length < 8) return 'Use at least 8 characters';
            if (v.length > 128) return 'Use at most 128 characters';
            if (v == _current.text) return 'Choose a different password';
            return null;
          },
        ),
        _PasswordField(
          controller: _confirm,
          label: 'Confirm new password',
          autofillHints: const [AutofillHints.newPassword],
          textInputAction: TextInputAction.done,
          onSubmitted: (_) => _submit(),
          validator: (v) => v != _next.text ? 'Passwords don’t match' : null,
        ),
      ],
    );
  }
}

/* ----------------------------- Delete account ----------------------------- */

/// Full page (not a dialog) so the consequences are readable before the
/// user commits: explicit acknowledgement + password, then a final confirm.
class DeleteAccountScreen extends ConsumerStatefulWidget {
  const DeleteAccountScreen({super.key});

  @override
  ConsumerState<DeleteAccountScreen> createState() =>
      _DeleteAccountScreenState();
}

class _DeleteAccountScreenState extends ConsumerState<DeleteAccountScreen> {
  final _formKey = GlobalKey<FormState>();
  final _password = TextEditingController();
  bool _understood = false;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _password.dispose();
    super.dispose();
  }

  Future<void> _delete() async {
    if (!_formKey.currentState!.validate()) return;
    final colorScheme = Theme.of(context).colorScheme;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        icon: Icon(Icons.warning_amber_rounded, color: colorScheme.error),
        title: const Text('Delete your account?'),
        content: const Text('This is permanent and can’t be undone.'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Keep account'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: colorScheme.error,
              foregroundColor: colorScheme.onError,
            ),
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;

    setState(() {
      _busy = true;
      _error = null;
    });
    final navigator = Navigator.of(context);
    final messenger = ScaffoldMessenger.of(context);
    try {
      await ref
          .read(authProvider.notifier)
          .deleteAccount(password: _password.text);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = _accountError(
          e,
          'Deleting account',
          conflict:
              'You’re the only admin. Make another account an admin from the dashboard first.',
        );
      });
      return;
    }
    // Home-screen widgets pointed at this account's switches — empty them.
    try {
      await setPinnedSwitches(const []);
      await refreshAppShortcuts();
    } catch (_) {}
    navigator.popUntil((route) => route.isFirst);
    messenger.showSnackBar(
      const SnackBar(content: Text('Your account has been deleted.')),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final email = ref.watch(authProvider)?.email ?? '';
    const points = <(IconData, String)>[
      (Icons.person_off_outlined, 'Your account and sign-in are removed.'),
      (
        Icons.home_outlined,
        'Households you share: ownership passes to another member, and they keep their devices.',
      ),
      (
        Icons.power_off_outlined,
        'Households only you use: devices are released (they can be claimed again) and their schedules stop.',
      ),
      (Icons.key_off_outlined, 'API keys and hook URLs stop working.'),
      (
        Icons.phone_android_outlined,
        'Devices and widgets saved on this phone are cleared.',
      ),
    ];
    return Scaffold(
      appBar: AppBar(title: const Text('Delete account')),
      body: Form(
        key: _formKey,
        child: ListView(
          padding: const EdgeInsets.all(Spacing.md),
          children: [
            Container(
              padding: const EdgeInsets.all(Spacing.md),
              decoration: BoxDecoration(
                color: colorScheme.errorContainer.withValues(alpha: 0.5),
                borderRadius: BorderRadius.circular(16),
              ),
              child: Row(
                children: [
                  Icon(Icons.warning_amber_rounded, color: colorScheme.error),
                  const SizedBox(width: Spacing.sm),
                  Expanded(
                    child: Text(
                      'Deleting $email is permanent.',
                      style: theme.textTheme.titleSmall?.copyWith(
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: Spacing.md),
            Text('What happens', style: theme.textTheme.titleMedium),
            const SizedBox(height: Spacing.sm),
            for (final (icon, text) in points)
              Padding(
                padding: const EdgeInsets.only(bottom: Spacing.sm),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Icon(icon, size: 20, color: colorScheme.onSurfaceVariant),
                    const SizedBox(width: Spacing.sm),
                    Expanded(child: Text(text)),
                  ],
                ),
              ),
            const SizedBox(height: Spacing.sm),
            CheckboxListTile(
              value: _understood,
              onChanged: _busy
                  ? null
                  : (v) => setState(() => _understood = v ?? false),
              contentPadding: EdgeInsets.zero,
              controlAffinity: ListTileControlAffinity.leading,
              title: const Text('I understand this can’t be undone'),
            ),
            const SizedBox(height: Spacing.sm),
            _PasswordField(
              controller: _password,
              label: 'Your password',
              autofillHints: const [AutofillHints.password],
              textInputAction: TextInputAction.done,
            ),
            if (_error != null) ...[
              const SizedBox(height: Spacing.sm),
              Text(_error!, style: TextStyle(color: colorScheme.error)),
            ],
            const SizedBox(height: Spacing.md),
            FilledButton.icon(
              style: FilledButton.styleFrom(
                backgroundColor: colorScheme.error,
                foregroundColor: colorScheme.onError,
                minimumSize: const Size.fromHeight(48),
              ),
              onPressed: _understood && !_busy ? _delete : null,
              icon: _busy
                  ? SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: colorScheme.onError,
                      ),
                    )
                  : const Icon(Icons.delete_forever_outlined),
              label: const Text('Delete my account'),
            ),
          ],
        ),
      ),
    );
  }
}

/* --------------------------------- Bits ----------------------------------- */

class _Section extends StatelessWidget {
  const _Section(this.label);

  final String label;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        Spacing.md,
        Spacing.lg,
        Spacing.md,
        Spacing.xs,
      ),
      child: Text(
        label,
        style: theme.textTheme.labelLarge?.copyWith(
          color: theme.colorScheme.onSurfaceVariant,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}

class _IconBox extends StatelessWidget {
  const _IconBox(this.icon, {this.color});

  final IconData icon;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final tint = color ?? Theme.of(context).colorScheme.primary;
    return Container(
      width: 34,
      height: 34,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: tint.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Icon(icon, size: 18, color: tint),
    );
  }
}
