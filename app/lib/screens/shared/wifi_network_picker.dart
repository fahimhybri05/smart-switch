import 'package:flutter/material.dart';

import '../../services/device_api_client.dart';
import '../../theme/spacing.dart';

/// Runs a device-side WiFi scan (polling included) — e.g.
/// `DeviceApiClient.scanWifiUntilDone` or
/// `Esp8266ProvisioningClient.scanNetworks`. [refresh] forces a fresh scan
/// instead of the device's cached result.
typedef WifiScanFn = Future<List<WifiNetwork>> Function({bool refresh});

enum _PickerState { loading, ready, failed, unsupported }

/// "Nearby networks" list shown under an SSID field: auto-scans on open
/// (cached result first, the rescan button forces a fresh scan) and fills
/// [ssidController] on tap. The networks come from the DEVICE's radio, not
/// the phone's, so they're exactly what the device can reach. Typing by
/// hand always keeps working — a failed scan just says so, and firmware
/// without the scan endpoint ([WifiScanUnsupportedException]) hides the
/// picker entirely.
class WifiNetworkPicker extends StatefulWidget {
  const WifiNetworkPicker({
    super.key,
    required this.scan,
    required this.ssidController,
    this.passwordFocusNode,
    this.enabled = true,
    this.onSelected,
  });

  final WifiScanFn scan;
  final TextEditingController ssidController;

  /// Focused after picking a secured network, so the user can go straight
  /// to typing its password.
  final FocusNode? passwordFocusNode;
  final bool enabled;
  final ValueChanged<WifiNetwork>? onSelected;

  @override
  State<WifiNetworkPicker> createState() => _WifiNetworkPickerState();
}

class _WifiNetworkPickerState extends State<WifiNetworkPicker> {
  static const _collapsedCount = 6;

  _PickerState _state = _PickerState.loading;
  List<WifiNetwork> _networks = const [];
  bool _expanded = false;
  WifiNetwork? _picked;

  // Bumped per scan so a slow, superseded scan can't overwrite a newer one.
  int _generation = 0;

  @override
  void initState() {
    super.initState();
    widget.ssidController.addListener(_onSsidChanged);
    _run(refresh: false);
  }

  @override
  void didUpdateWidget(WifiNetworkPicker oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.ssidController != widget.ssidController) {
      oldWidget.ssidController.removeListener(_onSsidChanged);
      widget.ssidController.addListener(_onSsidChanged);
    }
  }

  @override
  void dispose() {
    widget.ssidController.removeListener(_onSsidChanged);
    super.dispose();
  }

  // Rebuild so the check mark / open-network hint follow manual edits.
  void _onSsidChanged() => setState(() {});

  Future<void> _run({required bool refresh}) async {
    final gen = ++_generation;
    setState(() => _state = _PickerState.loading);
    try {
      final networks = await widget.scan(refresh: refresh);
      if (!mounted || gen != _generation) return;
      setState(() {
        _networks = networks;
        _state = _PickerState.ready;
      });
    } on WifiScanUnsupportedException {
      if (!mounted || gen != _generation) return;
      setState(() => _state = _PickerState.unsupported);
    } catch (_) {
      if (!mounted || gen != _generation) return;
      setState(() => _state = _PickerState.failed);
    }
  }

  void _select(WifiNetwork network) {
    widget.ssidController.value = TextEditingValue(
      text: network.ssid,
      selection: TextSelection.collapsed(offset: network.ssid.length),
    );
    setState(() => _picked = network);
    widget.onSelected?.call(network);
    if (network.secure) {
      widget.passwordFocusNode?.requestFocus();
    } else {
      FocusScope.of(context).unfocus();
    }
  }

  static IconData _signalIcon(int rssi) => rssi >= -55
      ? Icons.signal_wifi_4_bar_rounded
      : rssi >= -67
      ? Icons.network_wifi_3_bar_rounded
      : rssi >= -75
      ? Icons.network_wifi_2_bar_rounded
      : Icons.network_wifi_1_bar_rounded;

  @override
  Widget build(BuildContext context) {
    if (_state == _PickerState.unsupported) return const SizedBox.shrink();

    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final loading = _state == _PickerState.loading;
    final currentSsid = widget.ssidController.text.trim();
    final visible = _expanded || _networks.length <= _collapsedCount
        ? _networks
        : _networks.take(_collapsedCount).toList();
    final picked = _picked;
    final mutedStyle = theme.textTheme.bodySmall?.copyWith(
      color: colors.onSurfaceVariant,
    );

    String? message;
    if (_state == _PickerState.failed) {
      message = "Couldn't scan — type the name instead.";
    } else if (loading && _networks.isEmpty) {
      message = 'Looking for networks…';
    } else if (_state == _PickerState.ready && _networks.isEmpty) {
      message = 'No networks found — type the name instead.';
    }

    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: Spacing.xs),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.only(left: Spacing.md),
              child: Row(
                children: [
                  Icon(
                    Icons.wifi_find_rounded,
                    size: 20,
                    color: colors.primary,
                  ),
                  const SizedBox(width: Spacing.sm),
                  Expanded(
                    child: Text(
                      'Nearby networks',
                      style: theme.textTheme.titleSmall,
                    ),
                  ),
                  if (loading)
                    const Padding(
                      padding: EdgeInsets.all(14),
                      child: SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      ),
                    )
                  else
                    IconButton(
                      tooltip: 'Scan again',
                      icon: const Icon(Icons.refresh_rounded),
                      onPressed: widget.enabled
                          ? () => _run(refresh: true)
                          : null,
                    ),
                ],
              ),
            ),
            if (message != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(
                  Spacing.md,
                  0,
                  Spacing.md,
                  Spacing.sm,
                ),
                child: Text(message, style: mutedStyle),
              ),
            for (final n in visible)
              ListTile(
                dense: true,
                enabled: widget.enabled,
                leading: Icon(_signalIcon(n.rssi)),
                title: Text(n.ssid, overflow: TextOverflow.ellipsis),
                trailing: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (n.secure)
                      Icon(
                        Icons.lock_outline_rounded,
                        size: 18,
                        color: colors.onSurfaceVariant,
                      ),
                    if (n.ssid == currentSsid) ...[
                      const SizedBox(width: Spacing.sm),
                      Icon(
                        Icons.check_rounded,
                        size: 20,
                        color: colors.primary,
                      ),
                    ],
                  ],
                ),
                onTap: () => _select(n),
              ),
            if (visible.length < _networks.length)
              Align(
                alignment: Alignment.centerLeft,
                child: TextButton(
                  onPressed: () => setState(() => _expanded = true),
                  child: Text('Show all ${_networks.length} networks'),
                ),
              ),
            if (picked != null && !picked.secure && picked.ssid == currentSsid)
              Padding(
                padding: const EdgeInsets.fromLTRB(
                  Spacing.md,
                  Spacing.xs,
                  Spacing.md,
                  Spacing.sm,
                ),
                child: Text(
                  '"${picked.ssid}" is an open network — leave the password '
                  'empty.',
                  style: mutedStyle,
                ),
              ),
          ],
        ),
      ),
    );
  }
}
