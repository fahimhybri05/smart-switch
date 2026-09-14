import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/local/known_device.dart';
import '../../providers/service_providers.dart';
import '../../services/discovery_service.dart';
import '../../services/provisioning/softap_provisioning_client.dart';
import '../../theme/spacing.dart';

/// Provisioning wizard:
///   1. First claim: the phone joins the device's SoftAP network manually
///      (system WiFi settings), then this screen runs ESP-IDF's
///      protocomm/Security1 handshake + wifi_provisioning config-send
///      natively (see docs/plan.md — no separate Espressif app needed),
///      followed by "Scan for device" (real mDNS) on the home LAN to claim it.
///   2. Reconfigure an already-claimed device's WiFi — fully real, plain
///      REST (POST /api/wifi, async 202 + poll).
///   3. Recovery pointer for an unreachable known device (BOOT-button hold).
class ProvisioningWizardScreen extends ConsumerStatefulWidget {
  const ProvisioningWizardScreen({super.key});

  @override
  ConsumerState<ProvisioningWizardScreen> createState() =>
      _ProvisioningWizardScreenState();
}

class _ProvisioningWizardScreenState
    extends ConsumerState<ProvisioningWizardScreen> {
  StreamSubscription<DiscoveredDevice>? _scanSub;
  bool _scanning = false;
  final List<DiscoveredDevice> _found = [];

  KnownDevice? _reconfigTarget;
  final _ssidController = TextEditingController();
  final _passwordController = TextEditingController();
  bool _reconfiguring = false;
  String? _reconfigStatusText;

  final _softApNameController = TextEditingController();
  final _homeSsidController = TextEditingController();
  final _homePasswordController = TextEditingController();
  bool _provisioning = false;
  String? _provisioningStatusText;

  @override
  void dispose() {
    _scanSub?.cancel();
    _ssidController.dispose();
    _passwordController.dispose();
    _softApNameController.dispose();
    _homeSsidController.dispose();
    _homePasswordController.dispose();
    super.dispose();
  }

  Future<void> _scan() async {
    setState(() {
      _scanning = true;
      _found.clear();
    });

    final discovery = ref.read(discoveryServiceProvider);
    _scanSub = discovery.startDiscovery().listen((device) {
      setState(() => _found.add(device));
    });

    await Future.delayed(const Duration(seconds: 6));
    await _scanSub?.cancel();
    await discovery.stopDiscovery();
    if (mounted) setState(() => _scanning = false);
  }

  Future<void> _provision() async {
    const softApPrefix = 'SmartSwitch-';
    final softApName = _softApNameController.text.trim();
    if (!softApName.startsWith(softApPrefix) ||
        softApName.length <= softApPrefix.length) {
      setState(
        () => _provisioningStatusText =
            'Enter the network name exactly as shown in WiFi settings '
            '(e.g. "SmartSwitch-esp-8e0198").',
      );
      return;
    }
    final pop = softApName.substring(softApPrefix.length);

    setState(() {
      _provisioning = true;
      _provisioningStatusText = null;
    });

    try {
      final outcome = await SoftApProvisioningClient().provision(
        pop: pop,
        ssid: _homeSsidController.text.trim(),
        password: _homePasswordController.text,
        onStatus: (status) {
          if (mounted) setState(() => _provisioningStatusText = status);
        },
      );
      if (outcome == ProvisioningOutcome.connected && mounted) {
        // Device just joined the home LAN — scan for it right away so the
        // user can claim it below without re-navigating.
        unawaited(_scan());
      }
    } on ProvisioningException catch (e) {
      if (mounted) setState(() => _provisioningStatusText = 'Failed: $e');
    } catch (e) {
      if (mounted) setState(() => _provisioningStatusText = 'Failed: $e');
    } finally {
      if (mounted) setState(() => _provisioning = false);
    }
  }

  Future<void> _claim(DiscoveredDevice device) async {
    final name = await showDialog<String>(
      context: context,
      builder: (context) => _NameDialog(initial: device.deviceId),
    );
    if (name == null) return;

    final known = KnownDevice(
      deviceId: device.deviceId,
      mdnsHostname: device.host,
      lastKnownIp: device.host,
      friendlyName: name,
    );
    await ref.read(knownDevicesProvider.notifier).upsert(known);

    // Best-effort: give the device the phone's timezone so clock-type
    // schedules fire at the right local time (see docs/plan.md). Silently
    // ignored on failure — a manual override is also in Settings.
    try {
      await ref
          .read(activeDeviceApiClientProvider(known))
          .setTimezone(DateTime.now().timeZoneOffset.inMinutes);
    } catch (_) {}

    if (mounted) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text('Added "$name"')));
    }
  }

  Future<void> _sendReconfig() async {
    final target = _reconfigTarget;
    if (target == null) return;

    setState(() {
      _reconfiguring = true;
      _reconfigStatusText = null;
    });

    try {
      final client = ref.read(activeDeviceApiClientProvider(target));
      await client.requestWifiReconfig(
        ssid: _ssidController.text.trim(),
        password: _passwordController.text,
      );

      setState(
        () => _reconfigStatusText =
            'Testing… the device may briefly disconnect (up to ~20s).',
      );

      // Poll GET /api/info a few times to learn the outcome.
      for (var i = 0; i < 8; i++) {
        await Future.delayed(const Duration(seconds: 3));
        try {
          final info = await client.getInfo();
          if (mounted) {
            setState(
              () => _reconfigStatusText = 'Status: ${info.wifiReconfigState}',
            );
          }
          if (info.wifiReconfigState == 'CONNECTED' ||
              info.wifiReconfigState == 'FAILED_ROLLED_BACK') {
            break;
          }
        } catch (_) {
          if (mounted) {
            setState(
              () => _reconfigStatusText = 'Device unreachable — still testing…',
            );
          }
        }
      }
    } catch (e) {
      if (mounted) {
        setState(() => _reconfigStatusText = 'Failed to start reconfig: $e');
      }
    } finally {
      if (mounted) setState(() => _reconfiguring = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final devices = ref.watch(knownDevicesProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('Add / Reconnect Device')),
      body: ListView(
        padding: const EdgeInsets.all(Spacing.md),
        children: [
          _WizardSection(
            number: 1,
            icon: Icons.wifi_tethering,
            title: 'First-time claim',
            children: [
              const Text(
                'Join your phone\'s WiFi to the device\'s SoftAP network first '
                '(look for "SmartSwitch-<id>" in your system WiFi settings), '
                'then come back here and fill in the network name below plus '
                'your home WiFi to provision it — no extra app needed.',
              ),
              const SizedBox(height: Spacing.md),
              TextField(
                controller: _softApNameController,
                decoration: const InputDecoration(
                  labelText: 'SoftAP network name',
                  hintText: 'SmartSwitch-esp-8e0198',
                ),
              ),
              const SizedBox(height: Spacing.sm),
              TextField(
                controller: _homeSsidController,
                decoration: const InputDecoration(labelText: 'Home WiFi SSID'),
              ),
              const SizedBox(height: Spacing.sm),
              TextField(
                controller: _homePasswordController,
                decoration: const InputDecoration(
                  labelText: 'Home WiFi password',
                ),
                obscureText: true,
              ),
              const SizedBox(height: Spacing.md),
              FilledButton.icon(
                onPressed: _provisioning ? null : _provision,
                icon: _provisioning
                    ? const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.wifi_password),
                label: Text(
                  _provisioning ? 'Provisioning…' : 'Provision device',
                ),
              ),
              if (_provisioningStatusText != null)
                Padding(
                  padding: const EdgeInsets.only(top: Spacing.sm),
                  child: Text(_provisioningStatusText!),
                ),
              const SizedBox(height: Spacing.lg),
              const Divider(),
              const SizedBox(height: Spacing.sm),
              Text(
                'Already on your home WiFi? Scan for the device directly:',
                style: Theme.of(context).textTheme.bodySmall,
              ),
              const SizedBox(height: Spacing.sm),
              FilledButton.icon(
                onPressed: _scanning ? null : _scan,
                icon: _scanning
                    ? const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.wifi_find),
                label: Text(_scanning ? 'Scanning…' : 'Scan for device'),
              ),
              for (final device in _found)
                Padding(
                  padding: const EdgeInsets.only(top: Spacing.sm),
                  child: ListTile(
                    tileColor: Theme.of(
                      context,
                    ).colorScheme.surfaceContainerHighest,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12),
                    ),
                    leading: const Icon(Icons.developer_board),
                    title: Text(device.deviceId),
                    subtitle: Text('${device.host}:${device.port}'),
                    trailing: FilledButton.tonal(
                      onPressed: () => _claim(device),
                      child: const Text('Add'),
                    ),
                  ),
                ),
              if (!_scanning && _found.isEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: Spacing.sm),
                  child: Text(
                    'No devices found yet.',
                    style: TextStyle(
                      fontStyle: FontStyle.italic,
                      color: Theme.of(context).colorScheme.onSurfaceVariant,
                    ),
                  ),
                ),
            ],
          ),
          _WizardSection(
            number: 2,
            icon: Icons.wifi_password,
            title: "Reconfigure an existing device's WiFi",
            children: [
              if (devices.isEmpty)
                const Text('No known devices yet.')
              else ...[
                DropdownButtonFormField<String>(
                  initialValue: _reconfigTarget?.deviceId,
                  decoration: const InputDecoration(labelText: 'Device'),
                  items: [
                    for (final d in devices)
                      DropdownMenuItem(
                        value: d.deviceId,
                        child: Text(d.friendlyName),
                      ),
                  ],
                  onChanged: (id) => setState(
                    () => _reconfigTarget = devices.firstWhere(
                      (d) => d.deviceId == id,
                    ),
                  ),
                ),
                const SizedBox(height: Spacing.sm),
                TextField(
                  controller: _ssidController,
                  decoration: const InputDecoration(labelText: 'New WiFi SSID'),
                ),
                const SizedBox(height: Spacing.sm),
                TextField(
                  controller: _passwordController,
                  decoration: const InputDecoration(
                    labelText: 'New WiFi password',
                  ),
                  obscureText: true,
                ),
                const SizedBox(height: Spacing.md),
                FilledButton(
                  onPressed: (_reconfigTarget == null || _reconfiguring)
                      ? null
                      : _sendReconfig,
                  child: _reconfiguring
                      ? const SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Text('Send new credentials'),
                ),
                if (_reconfigStatusText != null)
                  Padding(
                    padding: const EdgeInsets.only(top: Spacing.sm),
                    child: Text(_reconfigStatusText!),
                  ),
              ],
            ],
          ),
          _WizardSection(
            number: 3,
            icon: Icons.help_outline,
            title: 'Device unreachable?',
            children: const [
              Text(
                'Hold the device\'s BOOT button for ~5 seconds to re-enter '
                'provisioning mode without erasing its switches/schedules, then '
                'repeat step 1. A longer hold (~12s) does a full factory reset.',
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _WizardSection extends StatelessWidget {
  const _WizardSection({
    required this.number,
    required this.icon,
    required this.title,
    required this.children,
  });

  final int number;
  final IconData icon;
  final String title;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(Spacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                CircleAvatar(
                  radius: 14,
                  backgroundColor: colorScheme.primaryContainer,
                  child: Text(
                    '$number',
                    style: TextStyle(
                      color: colorScheme.onPrimaryContainer,
                      fontSize: 13,
                    ),
                  ),
                ),
                const SizedBox(width: Spacing.sm),
                Icon(icon, size: 20, color: colorScheme.onSurfaceVariant),
                const SizedBox(width: Spacing.xs),
                Expanded(
                  child: Text(
                    title,
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                ),
              ],
            ),
            const SizedBox(height: Spacing.sm),
            ...children,
          ],
        ),
      ),
    );
  }
}

class _NameDialog extends StatefulWidget {
  const _NameDialog({required this.initial});

  final String initial;

  @override
  State<_NameDialog> createState() => _NameDialogState();
}

class _NameDialogState extends State<_NameDialog> {
  late final TextEditingController _controller = TextEditingController(
    text: widget.initial,
  );

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Name this device'),
      content: TextField(controller: _controller, autofocus: true),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () => Navigator.of(context).pop(_controller.text.trim()),
          child: const Text('Add'),
        ),
      ],
    );
  }
}
