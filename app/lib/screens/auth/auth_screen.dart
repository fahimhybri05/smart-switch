import 'package:flutter/material.dart';
import 'package:flutter_animate/flutter_animate.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../providers/service_providers.dart';
import '../../theme/motion.dart';
import '../../services/backend/backend_api_exception.dart';
import '../../services/backend/credential_store.dart';
import '../../theme/app_theme.dart';
import '../../theme/spacing.dart';

final _emailRegex = RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$');

/// Login and signup are the same form (email + password) against the same
/// two backend endpoints — one screen, toggled by [isSignup], rather than
/// duplicating the form/validation/error-handling logic across two files.
class AuthScreen extends ConsumerStatefulWidget {
  const AuthScreen({super.key, required this.isSignup});

  final bool isSignup;

  @override
  ConsumerState<AuthScreen> createState() => _AuthScreenState();
}

class _AuthScreenState extends ConsumerState<AuthScreen> {
  late bool _isSignup = widget.isSignup;
  final _emailController = TextEditingController();
  final _passwordController = TextEditingController();
  final _passwordFocusNode = FocusNode();
  final _formKey = GlobalKey<FormState>();
  bool _submitting = false;
  bool _showPassword = false;
  bool _rememberMe = true;
  String? _errorText;

  @override
  void initState() {
    super.initState();
    _prefillSavedCredentials();
    // Surface a forced-logout explanation (see
    // AuthNotifier._doRefreshAccessToken /
    // sessionExpiredMessageProvider) exactly once, the moment this screen
    // mounts — a post-frame callback since showing a SnackBar needs a
    // built Scaffold. Cleared right after being read so it doesn't
    // reappear on a normal subsequent login/logout.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) {
        return;
      }
      final message = ref.read(sessionExpiredMessageProvider);
      if (message == null) {
        return;
      }
      ref.read(sessionExpiredMessageProvider.notifier).state = null;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(message)));
    });
  }

  /// Fills the form with the "Remember me" credentials, if any — login
  /// only, and never over something the user already started typing.
  Future<void> _prefillSavedCredentials() async {
    if (_isSignup) return;
    final creds = await CredentialStore.read();
    if (!mounted || creds == null) return;
    if (_emailController.text.isNotEmpty || _passwordController.text.isNotEmpty) return;
    setState(() {
      _emailController.text = creds.email;
      _passwordController.text = creds.password;
      _rememberMe = true;
    });
  }

  @override
  void dispose() {
    _emailController.dispose();
    _passwordController.dispose();
    _passwordFocusNode.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!(_formKey.currentState?.validate() ?? false)) {
      return;
    }
    setState(() {
      _submitting = true;
      _errorText = null;
    });
    try {
      final notifier = ref.read(authProvider.notifier);
      if (_isSignup) {
        await notifier.signup(
          _emailController.text.trim(),
          _passwordController.text,
          rememberMe: _rememberMe,
        );
      } else {
        await notifier.login(
          _emailController.text.trim(),
          _passwordController.text,
          rememberMe: _rememberMe,
        );
      }
      if (mounted) {
        if (Navigator.of(context).canPop()) {
          Navigator.of(context).pop();
        }
      }
    } catch (e) {
      if (mounted) {
        setState(
          () => _errorText = e is BackendApiException
              ? e.message
              : "Couldn't reach the server. Check your connection and try again.",
        );
      }
    } finally {
      if (mounted) {
        setState(() => _submitting = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final backendUrl = ref.watch(backendUrlProvider);
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final colorScheme = Theme.of(context).colorScheme;

    return Scaffold(
      body: SafeArea(
        child: LayoutBuilder(
          builder: (context, constraints) {
            final isWide = constraints.maxWidth >= 900;
            final form = _AuthForm(
              formKey: _formKey,
              emailController: _emailController,
              passwordController: _passwordController,
              passwordFocusNode: _passwordFocusNode,
              showPassword: _showPassword,
              rememberMe: _rememberMe,
              isSignup: _isSignup,
              isSubmitting: _submitting,
              errorText: _errorText,
              backendUrl: backendUrl,
              onTogglePassword: () =>
                  setState(() => _showPassword = !_showPassword),
              onToggleRememberMe: (value) =>
                  setState(() => _rememberMe = value),
              onSubmit: _submit,
              onToggleMode: () => setState(() {
                _isSignup = !_isSignup;
                _errorText = null;
              }),
            );

            if (!isWide) {
              return SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(
                  Spacing.lg,
                  Spacing.xl,
                  Spacing.lg,
                  Spacing.lg,
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    _BrandHeader(
                          compact: true,
                          isSignup: _isSignup,
                          colorScheme: colorScheme,
                        )
                        .animate()
                        .fadeIn(duration: Motion.medium, curve: Motion.standard)
                        .slideY(
                          begin: -0.15,
                          end: 0,
                          duration: Motion.medium,
                          curve: Motion.standard,
                        ),
                    const SizedBox(height: Spacing.xl),
                    Card(
                      margin: EdgeInsets.zero,
                      child: Padding(
                        padding: const EdgeInsets.all(Spacing.lg),
                        child: form,
                      ),
                    ).animate().fadeIn(
                      delay: Motion.fast,
                      duration: Motion.medium,
                      curve: Motion.standard,
                    ),
                  ],
                ),
              );
            }

            return Row(
              children: [
                Expanded(
                  flex: 11,
                  child: _WelcomePanel(
                    isDark: isDark,
                    colorScheme: colorScheme,
                  ),
                ),
                Expanded(
                  flex: 9,
                  child: SingleChildScrollView(
                    padding: const EdgeInsets.symmetric(
                      horizontal: Spacing.xl,
                      vertical: Spacing.xl,
                    ),
                    child: Center(
                      child: ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 440),
                        child: form
                            .animate()
                            .fadeIn(
                              duration: Motion.medium,
                              curve: Motion.standard,
                            )
                            .slideX(
                              begin: 0.05,
                              end: 0,
                              duration: Motion.medium,
                              curve: Motion.standard,
                            ),
                      ),
                    ),
                  ),
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}

class _AuthForm extends StatelessWidget {
  const _AuthForm({
    required this.formKey,
    required this.emailController,
    required this.passwordController,
    required this.passwordFocusNode,
    required this.showPassword,
    required this.rememberMe,
    required this.isSignup,
    required this.isSubmitting,
    required this.errorText,
    required this.backendUrl,
    required this.onTogglePassword,
    required this.onToggleRememberMe,
    required this.onSubmit,
    required this.onToggleMode,
  });

  final GlobalKey<FormState> formKey;
  final TextEditingController emailController;
  final TextEditingController passwordController;
  final FocusNode passwordFocusNode;
  final bool showPassword;
  final bool rememberMe;
  final bool isSignup;
  final bool isSubmitting;
  final String? errorText;
  final String? backendUrl;
  final VoidCallback onTogglePassword;
  final ValueChanged<bool> onToggleRememberMe;
  final VoidCallback onSubmit;
  final VoidCallback onToggleMode;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final title = isSignup ? 'Create your account' : 'Welcome back';
    final subtitle = isSignup
        ? 'Set up your home control space in seconds.'
        : 'Your home, quietly in sync.';

    return Form(
      key: formKey,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: Theme.of(context).textTheme.headlineMedium),
          const SizedBox(height: Spacing.xs),
          Text(
            subtitle,
            style: Theme.of(context).textTheme.bodyLarge?.copyWith(
              color: colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: Spacing.xl),
          TextFormField(
            controller: emailController,
            decoration: const InputDecoration(
              labelText: 'Email address',
              prefixIcon: Icon(Icons.alternate_email_rounded),
            ),
            keyboardType: TextInputType.emailAddress,
            textInputAction: TextInputAction.next,
            autocorrect: false,
            onFieldSubmitted: (_) => passwordFocusNode.requestFocus(),
            validator: (value) {
              final trimmed = value?.trim() ?? '';
              if (trimmed.isEmpty) {
                return 'Enter your email address';
              }
              if (!_emailRegex.hasMatch(trimmed)) {
                return 'Enter a valid email address';
              }
              return null;
            },
          ),
          const SizedBox(height: Spacing.md),
          TextFormField(
            controller: passwordController,
            focusNode: passwordFocusNode,
            decoration: InputDecoration(
              labelText: 'Password',
              prefixIcon: const Icon(Icons.lock_outline_rounded),
              suffixIcon: IconButton(
                tooltip: showPassword ? 'Hide password' : 'Show password',
                onPressed: onTogglePassword,
                icon: Icon(
                  showPassword
                      ? Icons.visibility_off_outlined
                      : Icons.visibility_outlined,
                ),
              ),
            ),
            obscureText: !showPassword,
            textInputAction: TextInputAction.done,
            onFieldSubmitted: (_) => onSubmit(),
            validator: (value) => value == null || value.length < 8
                ? 'Use at least 8 characters'
                : null,
          ),
          if (!isSignup)
            CheckboxListTile(
              value: rememberMe,
              onChanged: (value) => onToggleRememberMe(value ?? true),
              controlAffinity: ListTileControlAffinity.leading,
              contentPadding: EdgeInsets.zero,
              dense: true,
              title: const Text('Remember me'),
              subtitle: const Text('Stay signed in on this device'),
            ),
          const SizedBox(height: Spacing.md),
          if (backendUrl != null)
            Row(
              children: [
                Icon(
                  Icons.cloud_done_rounded,
                  size: 18,
                  color: colorScheme.primary,
                ),
                const SizedBox(width: Spacing.xs),
                Expanded(
                  child: Text(
                    'Connected to your Smart Switch server',
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: colorScheme.onSurfaceVariant,
                    ),
                  ),
                ),
              ],
            )
          else
            Text(
              'Set a backend server URL in Settings first.',
              style: TextStyle(color: colorScheme.error),
            ),
          const SizedBox(height: Spacing.md),
          SizedBox(
            width: double.infinity,
            child: FilledButton.icon(
              onPressed: (isSubmitting || backendUrl == null) ? null : onSubmit,
              icon: isSubmitting
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : Icon(
                      isSignup
                          ? Icons.arrow_forward_rounded
                          : Icons.login_rounded,
                    ),
              label: Text(isSignup ? 'Create account' : 'Log in'),
            ),
          ),
          if (errorText != null)
            Padding(
              padding: const EdgeInsets.only(top: Spacing.md),
              child: Text(
                errorText!,
                style: TextStyle(color: colorScheme.error),
              ),
            ),
          const SizedBox(height: Spacing.lg),
          Center(
            child: TextButton(
              onPressed: onToggleMode,
              child: Text(
                isSignup
                    ? 'Already have an account? Log in'
                    : "Don't have an account? Create one",
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _BrandHeader extends StatelessWidget {
  const _BrandHeader({
    required this.compact,
    required this.isSignup,
    required this.colorScheme,
  });

  final bool compact;
  final bool isSignup;
  final ColorScheme colorScheme;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Container(
          width: compact ? 52 : 64,
          height: compact ? 52 : 64,
          decoration: BoxDecoration(
            color: colorScheme.primary,
            borderRadius: BorderRadius.circular(18),
            boxShadow: [
              BoxShadow(
                color: colorScheme.primary.withValues(alpha: 0.35),
                blurRadius: 16,
                offset: const Offset(0, 6),
              ),
            ],
          ),
          child: Icon(
            Icons.bolt_rounded,
            color: colorScheme.onPrimary,
            size: compact ? 28 : 34,
          ),
        ),
        const SizedBox(width: Spacing.md),
        Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Smart Switch',
              style: Theme.of(context).textTheme.labelLarge?.copyWith(
                fontWeight: FontWeight.w700,
                color: colorScheme.primary,
              ),
            ),
            Text(
              isSignup ? 'Start your home story' : 'Control, simplified',
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ),
      ],
    );
  }
}

class _WelcomePanel extends StatelessWidget {
  const _WelcomePanel({required this.isDark, required this.colorScheme});

  final bool isDark;
  final ColorScheme colorScheme;

  @override
  Widget build(BuildContext context) {
    final panelColors = context.panelColors;
    return Container(
      height: double.infinity,
      padding: const EdgeInsets.all(Spacing.xl),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [
            colorScheme.primary,
            isDark ? panelColors.stage : panelColors.accentStrong,
          ],
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _BrandHeader(
            compact: false,
            isSignup: false,
            colorScheme: colorScheme,
          ),
          const Spacer(),
          Icon(
            Icons.home_work_rounded,
            size: 92,
            color: colorScheme.onPrimary.withValues(alpha: 0.9),
          ),
          const SizedBox(height: Spacing.lg),
          Text(
            'A calmer way\nto run your home.',
            style: Theme.of(context).textTheme.displaySmall?.copyWith(
              color: colorScheme.onPrimary,
              fontWeight: FontWeight.w800,
              height: 1.05,
            ),
          ),
          const SizedBox(height: Spacing.md),
          Text(
            'See what is happening, make one-tap changes, and keep every room in rhythm.',
            style: Theme.of(context).textTheme.bodyLarge?.copyWith(
              color: colorScheme.onPrimary.withValues(alpha: 0.78),
              height: 1.4,
            ),
          ),
          const SizedBox(height: Spacing.xl),
          Wrap(
            spacing: Spacing.sm,
            runSpacing: Spacing.sm,
            children: const [
              _FeatureTag(icon: Icons.bolt_rounded, label: 'Instant control'),
              _FeatureTag(icon: Icons.wifi_rounded, label: 'Local-first'),
              _FeatureTag(icon: Icons.schedule_rounded, label: 'Schedules'),
            ],
          ),
          const Spacer(),
          Text(
            'Smart Switch',
            style: Theme.of(context).textTheme.labelSmall?.copyWith(
              color: colorScheme.onPrimary.withValues(alpha: 0.58),
              fontWeight: FontWeight.w600,
            ),
          ),
        ],
      ),
    );
  }
}

class _FeatureTag extends StatelessWidget {
  const _FeatureTag({required this.icon, required this.label});

  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        color: Colors.white.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: Colors.white.withValues(alpha: 0.16)),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 15, color: Colors.white),
            const SizedBox(width: 6),
            Text(
              label,
              style: const TextStyle(
                color: Colors.white,
                fontSize: 12,
                fontWeight: FontWeight.w700,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
