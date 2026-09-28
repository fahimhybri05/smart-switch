import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/local/known_device.dart';
import '../../providers/service_providers.dart';
import '../../services/device_api_client.dart';
import '../../theme/spacing.dart';
import '../shared/friendly_error.dart';
import '../shared/wifi_network_picker.dart';

enum _Phase { idle, sending, testing, connected, rolledBack, unconfirmed }

/// Moves an already-set-up device onto a different WiFi network.
///
/// POST /api/wifi (LAN or cloud relay) → the device keeps its current
/// network as a fallback while it test-connects to the new one (~15 s),
/// then either stays on the new network or rolls back. The device drops
/// off both LAN and cloud during the test, so polling GET /api/wifi fails
/// for a while — that's expected, not an error.
class ChangeWifiScreen extends ConsumerStatefulWidget {
  const ChangeWifiScreen({super.key, required this.device});

  final KnownDevice device;

  @override
  ConsumerState<ChangeWifiScreen> createState() => _ChangeWifiScreenState();
}

class _ChangeWifiScreenState extends ConsumerState<ChangeWifiScreen> {
  static const _pollInterval = Duration(seconds: 3);
  static const _pollAttempts =
      20; // ~60 s: 15 s test + reconnect + cloud re-auth

  final _formKey = GlobalKey<FormState>();
  final _ssidController = TextEditingController();
  final _passwordController = TextEditingController();
  final _passwordFocus = FocusNode();
  bool _obscure = true;

  WifiStatus? _current;
  bool _loadingCurrent = true;

  _Phase _phase = _Phase.idle;
  String? _error;
  String? _targetSsid;
  bool _disposed = false;

  DeviceApiClient get _client =>
      ref.read(activeDeviceApiClientProvider(widget.device));

  @override
  void initState() {
    super.initState();
    _loadCurrent();
  }

  @override
  void dispose() {
    _disposed = true;
    _ssidController.dispose();
    _passwordController.dispose();
    _passwordFocus.dispose();
    super.dispose();
  }

  Future<void> _loadCurrent() async {
    setState(() => _loadingCurrent = true);
    WifiStatus? status;
    try {
      status = await _client.getWifiStatus();
    } catch (_) {
      // Older firmware without GET /api/wifi, or device offline — the form
      // still works; we just can't show the current network.
    }
    if (!mounted) return;
    setState(() {
      _current = status;
      _loadingCurrent = false;
    });
  }

  Future<void> _submit() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    final ssid = _ssidController.text.trim();
    FocusScope.of(context).unfocus();
    setState(() {
      _phase = _Phase.sending;
      _error = null;
      _targetSsid = ssid;
    });

    try {
      await _client.requestWifiReconfig(
        ssid: ssid,
        password: _passwordController.text,
      );
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _phase = _Phase.idle;
        _error = e is DeviceApiException && e.statusCode == 409
            ? 'A WiFi change is already in progress on this device. '
                  'Wait a moment and try again.'
            : e is DeviceApiException && e.statusCode == 400
            ? 'The device rejected those details: ${e.message}'
            : friendlyErrorMessage(e, 'Change WiFi');
      });
      return;
    }

    if (!mounted) return;
    setState(() => _phase = _Phase.testing);

    for (var i = 0; i < _pollAttempts; i++) {
      await Future<void>.delayed(_pollInterval);
      if (_disposed) return;
      WifiStatus status;
      try {
        status = await _client.getWifiStatus();
      } catch (_) {
        continue; // expected while the device is switching networks
      }
      if (status.state == 'CONNECTED' && status.ssid == ssid) {
        if (!mounted) return;
        setState(() {
          _phase = _Phase.connected;
          _current = status;
        });
        _passwordController.clear();
        return;
      }
      if (status.state == 'FAILED_ROLLED_BACK') {
        if (!mounted) return;
        setState(() {
          _phase = _Phase.rolledBack;
          _current = status;
        });
        return;
      }
    }
    if (!mounted) return;
    setState(() => _phase = _Phase.unconfirmed);
  }

  @override
  Widget build(BuildContext context) {
    final busy = _phase == _Phase.sending || _phase == _Phase.testing;
    return Scaffold(
      appBar: AppBar(title: const Text('Change WiFi')),
      body: ListView(
        padding: const EdgeInsets.all(Spacing.md),
        children: [
          _CurrentNetworkCard(
            loading: _loadingCurrent,
            status: _current,
            onRefresh: busy ? null : _loadCurrent,
          ),
          const SizedBox(height: Spacing.lg),
          Form(
            key: _formKey,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                TextFormField(
                  controller: _ssidController,
                  enabled: !busy,
                  textInputAction: TextInputAction.next,
                  autocorrect: false,
                  decoration: const InputDecoration(
                    labelText: 'New WiFi network name',
                    prefixIcon: Icon(Icons.wifi_rounded),
                  ),
                  validator: (v) {
                    final t = v?.trim() ?? '';
                    if (t.isEmpty) return 'Enter the network name';
                    if (t.length > 32) return 'At most 32 characters';
                    return null;
                  },
                ),
                const SizedBox(height: Spacing.sm),
                // Networks the device itself can see — tapping one fills
                // the name above. Hidden on firmware without the scan.
                WifiNetworkPicker(
                  scan: ({bool refresh = false}) =>
                      _client.scanWifiUntilDone(refresh: refresh),
                  ssidController: _ssidController,
                  passwordFocusNode: _passwordFocus,
                  enabled: !busy,
                ),
                const SizedBox(height: Spacing.sm),
                TextFormField(
                  controller: _passwordController,
                  focusNode: _passwordFocus,
                  enabled: !busy,
                  obscureText: _obscure,
                  autocorrect: false,
                  enableSuggestions: false,
                  onFieldSubmitted: (_) => busy ? null : _submit(),
                  decoration: InputDecoration(
                    labelText: 'Password',
                    helperText: 'Leave empty for an open network',
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
                  validator: (v) {
                    final len = v?.length ?? 0;
                    if (len != 0 && (len < 8 || len > 64)) {
                      return 'WiFi passwords are 8–64 characters';
                    }
                    return null;
                  },
                ),
                const SizedBox(height: Spacing.md),
                FilledButton.icon(
                  onPressed: busy ? null : _submit,
                  icon: busy
                      ? const SizedBox(
                          width: 16,
                          height: 16,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.swap_horiz_rounded),
                  label: Text(busy ? 'Switching…' : 'Switch network'),
                ),
              ],
            ),
          ),
          const SizedBox(height: Spacing.md),
          _StatusMessage(
            phase: _phase,
            error: _error,
            targetSsid: _targetSsid,
            current: _current,
          ),
          const SizedBox(height: Spacing.lg),
          Text(
            'If the new network doesn\'t work, the device goes back to its '
            'current one automatically. To start over completely, hold the '
            'device\'s FLASH button for 7 seconds — that erases WiFi and all '
            'settings on the device.',
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ],
      ),
    );
  }
}

class _CurrentNetworkCard extends StatelessWidget {
  const _CurrentNetworkCard({
    required this.loading,
    required this.status,
    required this.onRefresh,
  });

  final bool loading;
  final WifiStatus? status;
  final VoidCallback? onRefresh;

  @override
  Widget build(BuildContext context) {
    final s = status;
    final subtitle = loading
        ? 'Checking…'
        : s == null
        ? 'Unavailable right now'
        : s.ssid.isEmpty
        ? 'Not connected'
        : s.connected
        ? '${s.ssid}${s.rssi == null ? '' : ' · ${s.rssi} dBm'}'
              '${s.ip == null ? '' : ' · IP ${s.ip}'}'
        : '${s.ssid} (not connected)';
    return Card(
      margin: EdgeInsets.zero,
      child: ListTile(
        leading: const Icon(Icons.router_outlined),
        title: const Text('Current network'),
        subtitle: Text(subtitle),
        trailing: IconButton(
          tooltip: 'Refresh',
          icon: const Icon(Icons.refresh_rounded),
          onPressed: loading ? null : onRefresh,
        ),
      ),
    );
  }
}

class _StatusMessage extends StatelessWidget {
  const _StatusMessage({
    required this.phase,
    required this.error,
    required this.targetSsid,
    required this.current,
  });

  final _Phase phase;
  final String? error;
  final String? targetSsid;
  final WifiStatus? current;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final (IconData? icon, Color? color, String? text) = switch (phase) {
      _ when error != null => (Icons.error_outline, colors.error, error),
      _Phase.idle => (null, null, null),
      _Phase.sending => (Icons.upload_rounded, colors.primary, 'Sending…'),
      _Phase.testing => (
        Icons.hourglass_top_rounded,
        colors.primary,
        'Trying "$targetSsid"… the device goes offline for up to a minute '
            'while it switches.',
      ),
      _Phase.connected => (
        Icons.check_circle_outline,
        colors.primary,
        'Done — the device is now on "$targetSsid".',
      ),
      _Phase.rolledBack => (
        Icons.undo_rounded,
        colors.error,
        'Couldn\'t join "$targetSsid" (wrong password or out of range). '
            '${current?.ssid.isNotEmpty ?? false ? 'The device went back to "${current!.ssid}".' : 'The device kept its previous setup.'}',
      ),
      _Phase.unconfirmed => (
        Icons.help_outline_rounded,
        colors.tertiary,
        'Couldn\'t confirm the result. If "$targetSsid" is correct the '
            'device should come back online on it shortly; otherwise it '
            'returns to its previous network.',
      ),
    };
    if (text == null) return const SizedBox.shrink();
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(icon, color: color, size: 20),
        const SizedBox(width: Spacing.sm),
        Expanded(child: Text(text)),
      ],
    );
  }
}
