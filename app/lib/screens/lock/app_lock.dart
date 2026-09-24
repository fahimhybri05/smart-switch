import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:local_auth/local_auth.dart';

import '../../providers/service_providers.dart';
import '../../theme/spacing.dart';

typedef AppLockSettings = ({bool enabled, int timeoutSeconds});

class AppLockNotifier extends Notifier<AppLockSettings> {
  @override
  AppLockSettings build() {
    final settings = ref.read(appSettingsServiceProvider);
    return (
      enabled: settings.getAppLockEnabled(),
      timeoutSeconds: settings.getAppLockTimeoutSeconds(),
    );
  }

  Future<void> setEnabled(bool enabled) async {
    await ref.read(appSettingsServiceProvider).setAppLockEnabled(enabled);
    state = (enabled: enabled, timeoutSeconds: state.timeoutSeconds);
  }

  Future<void> setTimeout(int seconds) async {
    await ref
        .read(appSettingsServiceProvider)
        .setAppLockTimeoutSeconds(seconds);
    state = (enabled: state.enabled, timeoutSeconds: seconds);
  }
}

final appLockProvider = NotifierProvider<AppLockNotifier, AppLockSettings>(
  AppLockNotifier.new,
);

/// True while the lock screen is covering the app — actions arriving from
/// outside (app-icon shortcuts) wait for this to turn false.
class AppLockedNotifier extends Notifier<bool> {
  @override
  bool build() => false;

  void set(bool locked) {
    if (state != locked) state = locked;
  }
}

final appLockedProvider = NotifierProvider<AppLockedNotifier, bool>(
  AppLockedNotifier.new,
);

final _localAuth = LocalAuthentication();

/// Whether the phone has any lock (biometric or PIN/pattern/password) that
/// the OS prompt can use.
Future<bool> appLockAvailable() async {
  try {
    return await _localAuth.isDeviceSupported();
  } catch (_) {
    return false;
  }
}

/// Shows the system prompt (fingerprint/face, falling back to the phone's
/// PIN/pattern/password). Returns true only on success; never throws.
Future<bool> authenticateUser(String reason) async {
  try {
    return await _localAuth.authenticate(
      localizedReason: reason,
      persistAcrossBackgrounding: true,
    );
  } catch (_) {
    return false;
  }
}

/// Covers the whole app with a lock screen on cold start and after the app
/// has been in the background longer than the chosen timeout. Only active
/// while signed in (the login screen has nothing to protect). Home-screen
/// widgets and the Quick Settings tile run outside the app and aren't gated.
class AppLockGate extends ConsumerStatefulWidget {
  const AppLockGate({super.key, required this.child});

  final Widget child;

  @override
  ConsumerState<AppLockGate> createState() => _AppLockGateState();
}

class _AppLockGateState extends ConsumerState<AppLockGate>
    with WidgetsBindingObserver {
  late bool _locked = ref.read(appLockProvider).enabled;
  DateTime? _backgroundedAt;
  bool _prompting = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    if (_locked) WidgetsBinding.instance.addPostFrameCallback((_) => _unlock());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // The biometric prompt itself pauses/resumes the activity on some
    // phones — ignore lifecycle changes it causes.
    if (_prompting) return;
    switch (state) {
      case AppLifecycleState.paused || AppLifecycleState.hidden:
        _backgroundedAt ??= DateTime.now();
      case AppLifecycleState.resumed:
        final since = _backgroundedAt;
        _backgroundedAt = null;
        final lock = ref.read(appLockProvider);
        if (!lock.enabled || since == null || _locked) return;
        if (DateTime.now().difference(since).inSeconds >= lock.timeoutSeconds) {
          setState(() => _locked = true);
          _unlock();
        }
      default:
        break;
    }
  }

  Future<void> _unlock() async {
    if (_prompting || !mounted) return;
    // A phone whose screen lock was removed can't prompt — don't strand
    // the user outside their own app.
    if (!await appLockAvailable()) {
      if (mounted) setState(() => _locked = false);
      return;
    }
    _prompting = true;
    final ok = await authenticateUser('Unlock Smart Control');
    _prompting = false;
    if (ok && mounted) setState(() => _locked = false);
  }

  @override
  Widget build(BuildContext context) {
    final signedIn = ref.watch(authProvider) != null;
    final enabled = ref.watch(appLockProvider.select((s) => s.enabled));
    final showLock = _locked && enabled && signedIn;
    if (ref.read(appLockedProvider) != showLock) {
      // Providers can't change during build — publish right after.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) ref.read(appLockedProvider.notifier).set(showLock);
      });
    }
    return Stack(
      children: [
        // Keeps its state underneath; excluded from semantics/taps while locked.
        ExcludeSemantics(
          excluding: showLock,
          child: IgnorePointer(ignoring: showLock, child: widget.child),
        ),
        if (showLock) _LockScreen(onUnlock: _unlock),
      ],
    );
  }
}

class _LockScreen extends StatelessWidget {
  const _LockScreen({required this.onUnlock});

  final VoidCallback onUnlock;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    return Positioned.fill(
      child: Material(
        color: colorScheme.surface,
        child: SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(Spacing.lg),
            child: Column(
              children: [
                const Spacer(),
                ClipRRect(
                  borderRadius: BorderRadius.circular(24),
                  child: Image.asset(
                    'assets/branding/logo.png',
                    width: 96,
                    height: 96,
                    errorBuilder: (_, _, _) => Icon(
                      Icons.lock_rounded,
                      size: 64,
                      color: colorScheme.primary,
                    ),
                  ),
                ),
                const SizedBox(height: Spacing.lg),
                Text(
                  'Smart Control is locked',
                  style: theme.textTheme.titleLarge?.copyWith(
                    fontWeight: FontWeight.w800,
                  ),
                ),
                const SizedBox(height: Spacing.xs),
                Text(
                  'Unlock with your fingerprint, face or screen lock.',
                  textAlign: TextAlign.center,
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: colorScheme.onSurfaceVariant,
                  ),
                ),
                const Spacer(),
                FilledButton.icon(
                  onPressed: onUnlock,
                  style: FilledButton.styleFrom(
                    minimumSize: const Size.fromHeight(52),
                  ),
                  icon: const Icon(Icons.fingerprint_rounded),
                  label: const Text('Unlock'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
