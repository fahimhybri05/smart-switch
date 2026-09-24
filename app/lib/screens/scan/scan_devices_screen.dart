import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_animate/flutter_animate.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/local/known_device.dart';
import '../../providers/service_providers.dart';
import '../../services/discovery_service.dart';
import '../../theme/motion.dart';
import '../../theme/spacing.dart';
import '../shared/friendly_error.dart';

/// Scans the LAN (mDNS, `_esp-switch._tcp`) for already-provisioned Smart
/// Switch devices not yet known to this phone — a second, faster path
/// alongside the QR-first `AddDeviceWizardScreen` for a device that's
/// already on the WiFi (a second household phone, or one removed from
/// Known devices without needing to redo WiFi setup). No WiFi/cloud work
/// happens here — just discovery + a straight `KnownDevicesNotifier.upsert`.
class ScanDevicesScreen extends ConsumerStatefulWidget {
  const ScanDevicesScreen({super.key});

  @override
  ConsumerState<ScanDevicesScreen> createState() => _ScanDevicesScreenState();
}

class _ScanDevicesScreenState extends ConsumerState<ScanDevicesScreen> {
  StreamSubscription<DiscoveredDevice>? _sub;
  bool _scanning = false;
  final List<DiscoveredDevice> _found = [];
  final Set<String> _addingIds = {};
  final Set<String> _addedIds = {};

  @override
  void initState() {
    super.initState();
    _startScan();
  }

  @override
  void dispose() {
    _sub?.cancel();
    ref.read(discoveryServiceProvider).stopDiscovery();
    super.dispose();
  }

  void _startScan() {
    setState(() {
      _found.clear();
      _addedIds.clear();
      _scanning = true;
    });

    final known = {
      for (final d in ref.read(knownDevicesProvider)) d.deviceId: d,
    };

    final discovery = ref.read(discoveryServiceProvider);
    _sub?.cancel();
    _sub = discovery.startDiscovery().listen((device) {
      if (!mounted) return;
      if (_found.any((d) => d.deviceId == device.deviceId)) return;
      // Already-added devices still show (marked added) instead of silently
      // vanishing, and a changed IP is refreshed so the device is reachable.
      final existing = known[device.deviceId];
      if (existing != null && existing.lastKnownIp != device.host) {
        ref
            .read(knownDevicesProvider.notifier)
            .upsert(existing.copyWith(lastKnownIp: device.host));
      }
      setState(() {
        _found.add(device);
        if (existing != null) _addedIds.add(device.deviceId);
      });
    });
  }

  Future<void> _stopScan() async {
    await _sub?.cancel();
    _sub = null;
    await ref.read(discoveryServiceProvider).stopDiscovery();
    if (mounted) setState(() => _scanning = false);
  }

  Future<void> _addDevice(DiscoveredDevice device) async {
    final name = await showDialog<String>(
      context: context,
      builder: (context) => _NameDialog(initial: device.deviceId),
    );
    if (name == null || !mounted) return;

    setState(() => _addingIds.add(device.deviceId));
    try {
      final known = KnownDevice(
        deviceId: device.deviceId,
        mdnsHostname: device.host,
        lastKnownIp: device.host,
        friendlyName: name,
      );
      await ref.read(knownDevicesProvider.notifier).upsert(known);
      if (mounted) {
        setState(() {
          _addingIds.remove(device.deviceId);
          _addedIds.add(device.deviceId);
        });
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Added "$name"')));
      }
    } catch (e) {
      if (mounted) {
        setState(() => _addingIds.remove(device.deviceId));
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(friendlyErrorMessage(e, 'Add'))));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Scan for devices'),
        actions: [
          IconButton(
            icon: Icon(
              _scanning ? Icons.stop_circle_outlined : Icons.refresh_rounded,
            ),
            tooltip: _scanning ? 'Stop scanning' : 'Scan again',
            onPressed: _scanning ? _stopScan : _startScan,
          ),
        ],
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(vertical: Spacing.lg),
            child: _RadarPulse(active: _scanning),
          ),
          Text(
            _scanning
                ? 'Scanning your WiFi network…'
                : _found.isEmpty
                ? 'Scan stopped'
                : 'Scan stopped — ${_found.length} found',
            style: Theme.of(context).textTheme.titleMedium,
          ),
          const SizedBox(height: Spacing.xs),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: Spacing.xl),
            child: Text(
              'Only devices already connected to this WiFi network show up '
              'here. A brand new device needs the QR setup instead.',
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
          ),
          const SizedBox(height: Spacing.md),
          Expanded(
            child: _found.isEmpty
                ? _EmptyState(scanning: _scanning)
                : ListView.builder(
                    padding: const EdgeInsets.symmetric(horizontal: Spacing.md),
                    itemCount: _found.length,
                    itemBuilder: (context, index) {
                      final device = _found[index];
                      return _FoundDeviceCard(
                            device: device,
                            adding: _addingIds.contains(device.deviceId),
                            added: _addedIds.contains(device.deviceId),
                            onAdd: () => _addDevice(device),
                          )
                          .animate(delay: Motion.stagger(index))
                          .fadeIn(
                            duration: Motion.medium,
                            curve: Motion.enter,
                          )
                          .slideX(
                            begin: 0.1,
                            end: 0,
                            duration: Motion.medium,
                            curve: Motion.enter,
                          );
                    },
                  ),
          ),
        ],
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState({required this.scanning});

  final bool scanning;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(Spacing.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              scanning ? Icons.wifi_find_rounded : Icons.wifi_off_rounded,
              size: 48,
              color: colorScheme.onSurfaceVariant,
            ),
            const SizedBox(height: Spacing.md),
            Text(
              scanning
                  ? 'Looking for devices…'
                  : 'No devices found on this network',
              textAlign: TextAlign.center,
              style: TextStyle(color: colorScheme.onSurfaceVariant),
            ),
          ],
        ),
      ),
    ).animate().fadeIn(duration: Motion.medium);
  }
}

class _FoundDeviceCard extends StatelessWidget {
  const _FoundDeviceCard({
    required this.device,
    required this.adding,
    required this.added,
    required this.onAdd,
  });

  final DiscoveredDevice device;
  final bool adding;
  final bool added;
  final VoidCallback onAdd;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return Card(
      margin: const EdgeInsets.only(bottom: Spacing.sm),
      child: ListTile(
        leading: Container(
          width: 40,
          height: 40,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: colorScheme.secondaryContainer,
            borderRadius: BorderRadius.circular(12),
          ),
          child: Icon(
            Icons.developer_board_rounded,
            color: colorScheme.onSecondaryContainer,
          ),
        ),
        title: Text(device.deviceId),
        subtitle: Text(device.host),
        trailing: added
            ? Icon(
                Icons.check_circle_rounded,
                color: colorScheme.tertiary,
              ).animate().scaleXY(
                begin: 0,
                end: 1,
                duration: Motion.medium,
                curve: Curves.easeOutBack,
              )
            : adding
            ? const SizedBox(
                width: 20,
                height: 20,
                child: CircularProgressIndicator(strokeWidth: 2),
              )
            : FilledButton.tonal(onPressed: onAdd, child: const Text('Add')),
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
      content: TextField(
        controller: _controller,
        autofocus: true,
        decoration: const InputDecoration(labelText: 'Name'),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () {
            final name = _controller.text.trim();
            Navigator.of(context).pop(name.isEmpty ? widget.initial : name);
          },
          child: const Text('Add'),
        ),
      ],
    );
  }
}

/// A small self-contained sonar/radar effect — three rings continuously
/// expanding and fading out from a center icon, phase-offset by a third of
/// the cycle each so they read as a steady pulse rather than three rings
/// blinking in lockstep. Deliberately hand-rolled with one repeating
/// [AnimationController] instead of flutter_animate's `.animate()` chain:
/// flutter_animate's per-effect `delay` only offsets the *first* cycle,
/// so three separately-delayed `.animate(onPlay: (c) => c.repeat())`
/// widgets would drift back into sync after the first loop.
class _RadarPulse extends StatefulWidget {
  const _RadarPulse({required this.active});

  final bool active;

  @override
  State<_RadarPulse> createState() => _RadarPulseState();
}

class _RadarPulseState extends State<_RadarPulse>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 2200),
  );

  @override
  void initState() {
    super.initState();
    if (widget.active) _controller.repeat();
  }

  @override
  void didUpdateWidget(covariant _RadarPulse oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.active && !_controller.isAnimating) {
      _controller.repeat();
    } else if (!widget.active && _controller.isAnimating) {
      _controller.stop();
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    const size = 160.0;
    return SizedBox(
      width: size,
      height: size,
      child: AnimatedBuilder(
        animation: _controller,
        builder: (context, _) {
          return Stack(
            alignment: Alignment.center,
            children: [
              for (var i = 0; i < 3; i++)
                _buildRing(colorScheme, size, (i / 3)),
              CircleAvatar(
                radius: 28,
                backgroundColor: colorScheme.primary,
                child: Icon(
                  Icons.wifi_find_rounded,
                  color: colorScheme.onPrimary,
                  size: 28,
                ),
              ),
            ],
          );
        },
      ),
    );
  }

  Widget _buildRing(
    ColorScheme colorScheme,
    double maxSize,
    double phaseOffset,
  ) {
    final phase = widget.active ? (_controller.value + phaseOffset) % 1.0 : 0.0;
    final scale = 0.25 + phase * 0.85;
    final opacity = widget.active ? (1 - phase).clamp(0.0, 1.0) * 0.5 : 0.0;
    return Opacity(
      opacity: opacity,
      child: Container(
        width: maxSize * scale,
        height: maxSize * scale,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          border: Border.all(color: colorScheme.primary, width: 2),
        ),
      ),
    );
  }
}
