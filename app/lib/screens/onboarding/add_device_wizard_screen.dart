import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../../models/device/switch_config.dart';
import '../../models/local/known_device.dart';
import '../../providers/service_providers.dart';
import '../../routing/app_routes.dart';
import '../../services/backend/backend_api_exception.dart';
import '../../services/backend/backend_devices_client.dart';
import '../../services/discovery_service.dart';
import '../../services/provisioning/esp8266_provisioning_client.dart';
import '../../services/provisioning/softap_provisioning_client.dart';
import '../../theme/spacing.dart';

typedef QrSetupPayload = ({String deviceId, String cloudSecret, String chip});

/// The QR sticker generated at flash time encodes exactly this — see each
/// firmware's boot-time log line (main.c / main.cpp) and docs/plan.md's
/// `qrencode -o sticker.png 'smartapp://device/setup?id=...&secret=...&chip=esp32|esp8266'`.
/// `chip` picks the WiFi-provisioning method (ESP32's Security1 handshake
/// vs the ESP8266 port's plain JSON form) — defaults to esp32 if absent,
/// matching every board flashed before this field existed.
QrSetupPayload? parseDeviceSetupUri(String raw) {
  final uri = Uri.tryParse(raw.trim());
  if (uri == null) {
    return null;
  }
  final id = uri.queryParameters['id'];
  final secret = uri.queryParameters['secret'];
  if (id == null || id.isEmpty || secret == null || secret.isEmpty) {
    return null;
  }
  final chip = uri.queryParameters['chip'];
  return (
    deviceId: id,
    cloudSecret: secret,
    chip: chip == 'esp8266' ? 'esp8266' : 'esp32',
  );
}

enum _Step { intro, manualEntry, found, wifi, findDevice, room, name, done }

/// Guided QR-first "Add Device" flow (see docs/plan.md). Reuses every
/// existing proven service underneath (SoftAP/Security1 handshake, mDNS
/// discovery, the backend devices client, KnownDevicesNotifier) — this
/// screen only orchestrates them into a single linear wizard instead of
/// today's `ProvisioningWizardScreen`'s three independent cards (which
/// stays around, unchanged, as "Advanced provisioning").
class AddDeviceWizardScreen extends ConsumerStatefulWidget {
  const AddDeviceWizardScreen({super.key});

  @override
  ConsumerState<AddDeviceWizardScreen> createState() =>
      _AddDeviceWizardScreenState();
}

class _AddDeviceWizardScreenState extends ConsumerState<AddDeviceWizardScreen> {
  _Step _step = _Step.intro;
  bool _busy = false;
  String? _statusText;
  String? _errorText;

  String? _deviceId;
  String? _cloudSecret;
  String? _lastKnownIp;
  String _chip = 'esp32';

  final _manualIdController = TextEditingController();
  final _manualSecretController = TextEditingController();
  final _manualIpController = TextEditingController();
  final _ssidController = TextEditingController();
  final _passwordController = TextEditingController();
  final _roomController = TextEditingController();
  final _nameController = TextEditingController();

  @override
  void dispose() {
    _manualIdController.dispose();
    _manualSecretController.dispose();
    _manualIpController.dispose();
    _ssidController.dispose();
    _passwordController.dispose();
    _roomController.dispose();
    _nameController.dispose();
    super.dispose();
  }

  Future<void> _openScanner() async {
    final result = await Navigator.of(context).push<QrSetupPayload>(
      MaterialPageRoute(builder: (_) => const _QrScanPage()),
    );
    if (result == null || !mounted) {
      return;
    }
    setState(() {
      _deviceId = result.deviceId;
      _cloudSecret = result.cloudSecret;
      _chip = result.chip;
      _nameController.text = result.deviceId;
      _step = _Step.found;
    });
  }

  void _confirmManualEntry() {
    final id = _manualIdController.text.trim();
    final secret = _manualSecretController.text.trim();
    if (id.isEmpty || secret.isEmpty) {
      setState(() => _errorText = 'Enter both the device ID and cloud secret.');
      return;
    }
    setState(() {
      _deviceId = id;
      _cloudSecret = secret;
      _nameController.text = id;
      _errorText = null;
      _step = _Step.found;
    });
  }

  Future<void> _provisionWifi() async {
    final deviceId = _deviceId!;
    setState(() {
      _busy = true;
      _errorText = null;
      _statusText = null;
    });

    try {
      void onStatus(String status) {
        if (mounted) setState(() => _statusText = status);
      }

      final outcome = _chip == 'esp8266'
          ? await Esp8266ProvisioningClient().provision(
              ssid: _ssidController.text.trim(),
              password: _passwordController.text,
              onStatus: onStatus,
            )
          : await SoftApProvisioningClient().provision(
              pop: deviceId,
              ssid: _ssidController.text.trim(),
              password: _passwordController.text,
              onStatus: onStatus,
            );
      if (outcome != ProvisioningOutcome.connected) {
        setState(() {
          _busy = false;
          _errorText = 'Could not connect the device to WiFi.';
        });
        return;
      }

      // _findDevice manages `_busy`/`_errorText` itself from here — don't
      // let this function's cleanup clobber its state (it starts a new
      // busy cycle synchronously below).
      if (mounted) setState(() => _step = _Step.findDevice);
      unawaited(_findDevice());
    } on ProvisioningException catch (e) {
      setState(() {
        _busy = false;
        _errorText = '$e';
      });
    } catch (e) {
      setState(() {
        _busy = false;
        _errorText = '$e';
      });
    }
  }

  // The device's own SoftAP disappears the moment it joins the home WiFi
  // (both chips drop it on success), so the *phone* also has to notice
  // that network vanished and rejoin its usual WiFi before mDNS discovery
  // has any hope of finding the device again — that can take phones far
  // longer than a few seconds. Runs its own busy/status state independent
  // of _provisionWifi's so "Search again" can be retried freely.
  Future<void> _findDevice() async {
    final deviceId = _deviceId!;
    setState(() {
      _busy = true;
      _errorText = null;
      _statusText = 'Waiting for your phone to rejoin your WiFi…';
    });

    final discovery = ref.read(discoveryServiceProvider);
    final completer = Completer<DiscoveredDevice?>();
    final sub = discovery.startDiscovery().listen((device) {
      if (device.deviceId == deviceId && !completer.isCompleted) {
        completer.complete(device);
      }
    });
    final found = await completer.future.timeout(
      const Duration(seconds: 30),
      onTimeout: () => null,
    );
    await sub.cancel();
    await discovery.stopDiscovery();

    if (!mounted) return;
    if (found == null) {
      setState(() {
        _busy = false;
        _errorText =
            "Couldn't find the device automatically yet. Make sure your "
            "phone has reconnected to your home WiFi, then try again — or "
            'enter its IP address manually (check your router).';
      });
      return;
    }

    await _completeSetupWithHost(found.host);
  }

  Future<void> _completeSetupWithHost(String host) async {
    final deviceId = _deviceId!;
    final known = KnownDevice(
      deviceId: deviceId,
      mdnsHostname: host,
      lastKnownIp: host,
      friendlyName: _nameController.text.trim().isEmpty
          ? deviceId
          : _nameController.text.trim(),
    );
    await ref.read(knownDevicesProvider.notifier).upsert(known);
    _lastKnownIp = host;

    // Best-effort, same as the existing wizard: local timezone + cloud
    // claim. Neither blocks finishing setup — cloud claiming only ever
    // applies if the user is logged in with a backend configured, and a
    // device without the cloud_client component simply won't have a
    // secret worth claiming with (still succeeds locally either way).
    try {
      await ref
          .read(activeDeviceApiClientProvider(known))
          .setTimezone(DateTime.now().timeZoneOffset.inMinutes);
    } catch (_) {}

    if (ref.read(authProvider) != null &&
        ref.read(backendUrlProvider) != null) {
      try {
        if (mounted) setState(() => _statusText = 'Enabling remote control…');
        final accessToken = await ensureFreshAccessToken(ref);
        await BackendDevicesClient(
          baseUrl: ref.read(backendUrlProvider)!,
          accessToken: accessToken,
        ).claim(
          deviceId: deviceId,
          cloudSecret: _cloudSecret!,
          friendlyName: known.friendlyName,
        );
      } on BackendApiException catch (_) {
        // Non-fatal — most likely this board's firmware predates
        // cloud_client, so the QR's secret doesn't match anything the
        // backend can verify yet. Local control still works either way.
      } catch (_) {}
    }

    if (mounted) {
      setState(() {
        _busy = false;
        _step = _Step.room;
      });
    }
  }

  Future<void> _useManualIp(String ip) async {
    final trimmed = ip.trim();
    if (trimmed.isEmpty) {
      setState(() => _errorText = 'Enter the device\'s IP address.');
      return;
    }
    setState(() {
      _busy = true;
      _errorText = null;
      _statusText = 'Connecting…';
    });
    try {
      // Confirms something matching this device actually answers at that
      // IP before committing to it — no fake success.
      final info = await ref
          .read(deviceApiClientProvider('http://$trimmed'))
          .getInfo();
      if (info.deviceId != _deviceId) {
        setState(
          () => _errorText =
              'That address answered as a different device (${info.deviceId}).',
        );
        return;
      }
      await _completeSetupWithHost(trimmed);
    } catch (e) {
      setState(() => _errorText = "Couldn't reach a device at $trimmed: $e");
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _applyRoom() async {
    final room = _roomController.text.trim();
    if (room.isEmpty) {
      setState(() => _step = _Step.name);
      return;
    }
    setState(() {
      _busy = true;
      _errorText = null;
    });
    try {
      final client = ref.read(deviceApiClientProvider('http://$_lastKnownIp'));
      final config = await client.getConfig();
      for (final sw in config.switches) {
        await client.upsertSwitch(
          SwitchConfig(
            channelIdx: sw.channelIdx,
            name: sw.name,
            zone: room,
            type: sw.type,
            defaultBootState: sw.defaultBootState,
          ),
        );
      }
      if (mounted) setState(() => _step = _Step.name);
    } catch (e) {
      setState(() => _errorText = "Couldn't set the room: $e");
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _finishNaming() async {
    final name = _nameController.text.trim();
    if (name.isNotEmpty && _deviceId != null) {
      final existing = await ref
          .read(deviceRegistryServiceProvider)
          .get(_deviceId!);
      if (existing != null) {
        await ref
            .read(knownDevicesProvider.notifier)
            .upsert(existing.copyWith(friendlyName: name));
      }
    }
    if (mounted) setState(() => _step = _Step.done);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Add device')),
      body: ListView(
        padding: const EdgeInsets.all(Spacing.md),
        children: [
          if (_errorText != null)
            Padding(
              padding: const EdgeInsets.only(bottom: Spacing.md),
              child: Text(
                _errorText!,
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
            ),
          switch (_step) {
            _Step.intro => _IntroStep(
              onScan: _openScanner,
              onManualEntry: () => setState(() => _step = _Step.manualEntry),
              onScanNetwork: () =>
                  Navigator.of(context).pushNamed(AppRoutes.scanDevices),
            ),
            _Step.manualEntry => _ManualEntryStep(
              idController: _manualIdController,
              secretController: _manualSecretController,
              chip: _chip,
              onChipChanged: (chip) => setState(() => _chip = chip),
              onContinue: _confirmManualEntry,
            ),
            _Step.found => _FoundStep(
              deviceId: _deviceId!,
              onContinue: () => setState(() => _step = _Step.wifi),
            ),
            _Step.wifi => _WifiStep(
              ssidController: _ssidController,
              passwordController: _passwordController,
              busy: _busy,
              statusText: _statusText,
              onProvision: _provisionWifi,
            ),
            _Step.findDevice => _FindDeviceStep(
              busy: _busy,
              statusText: _statusText,
              ipController: _manualIpController,
              onRetry: () => unawaited(_findDevice()),
              onUseManualIp: () =>
                  unawaited(_useManualIp(_manualIpController.text)),
            ),
            _Step.room => _RoomStep(
              roomController: _roomController,
              busy: _busy,
              onContinue: _applyRoom,
            ),
            _Step.name => _NameStep(
              nameController: _nameController,
              onContinue: _finishNaming,
            ),
            _Step.done => _DoneStep(
              onDone: () =>
                  Navigator.of(context).popUntil((route) => route.isFirst),
            ),
          },
        ],
      ),
    );
  }
}

class _IntroStep extends StatelessWidget {
  const _IntroStep({
    required this.onScan,
    required this.onManualEntry,
    required this.onScanNetwork,
  });

  final VoidCallback onScan;
  final VoidCallback onManualEntry;
  final VoidCallback onScanNetwork;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          'Add your smart switch',
          style: Theme.of(context).textTheme.headlineSmall,
        ),
        const SizedBox(height: Spacing.sm),
        const Text('Scan the QR code on your device.'),
        const SizedBox(height: Spacing.lg),
        FilledButton.icon(
          onPressed: onScan,
          icon: const Icon(Icons.qr_code_scanner),
          label: const Text('Scan QR code'),
        ),
        const SizedBox(height: Spacing.sm),
        TextButton(
          onPressed: onManualEntry,
          child: const Text("Can't scan? Enter device code manually"),
        ),
        const SizedBox(height: Spacing.lg),
        const Divider(),
        const SizedBox(height: Spacing.sm),
        Text('Already set up?', style: Theme.of(context).textTheme.titleSmall),
        const SizedBox(height: Spacing.xs),
        const Text(
          "If it's already on this WiFi (added from another phone, or "
          "removed from this one), scan the network to find it instead.",
        ),
        const SizedBox(height: Spacing.sm),
        OutlinedButton.icon(
          onPressed: onScanNetwork,
          icon: const Icon(Icons.wifi_find_rounded),
          label: const Text('Scan my network'),
        ),
      ],
    );
  }
}

class _ManualEntryStep extends StatelessWidget {
  const _ManualEntryStep({
    required this.idController,
    required this.secretController,
    required this.chip,
    required this.onChipChanged,
    required this.onContinue,
  });

  final TextEditingController idController;
  final TextEditingController secretController;
  final String chip;
  final ValueChanged<String> onChipChanged;
  final VoidCallback onContinue;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          'Enter device code',
          style: Theme.of(context).textTheme.headlineSmall,
        ),
        const SizedBox(height: Spacing.sm),
        const Text(
          "Both values are on the device's serial log at flash time and on "
          'the printed sticker.',
        ),
        const SizedBox(height: Spacing.lg),
        SegmentedButton<String>(
          segments: const [
            ButtonSegment(value: 'esp32', label: Text('ESP32')),
            ButtonSegment(value: 'esp8266', label: Text('ESP8266')),
          ],
          selected: {chip},
          onSelectionChanged: (selection) => onChipChanged(selection.first),
        ),
        const SizedBox(height: Spacing.md),
        TextField(
          controller: idController,
          decoration: const InputDecoration(labelText: 'Device ID'),
          autocorrect: false,
        ),
        const SizedBox(height: Spacing.sm),
        TextField(
          controller: secretController,
          decoration: const InputDecoration(labelText: 'Cloud secret'),
          autocorrect: false,
        ),
        const SizedBox(height: Spacing.lg),
        FilledButton(onPressed: onContinue, child: const Text('Continue')),
      ],
    );
  }
}

class _FoundStep extends StatelessWidget {
  const _FoundStep({required this.deviceId, required this.onContinue});

  final String deviceId;
  final VoidCallback onContinue;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Icon(
          Icons.check_circle,
          size: 64,
          color: Theme.of(context).colorScheme.primary,
        ),
        const SizedBox(height: Spacing.md),
        Text(
          'Smart Switch found',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.headlineSmall,
        ),
        const SizedBox(height: Spacing.xs),
        Text(
          deviceId,
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodyLarge,
        ),
        const SizedBox(height: Spacing.lg),
        const Text("Let's connect this switch to your WiFi."),
        const SizedBox(height: Spacing.md),
        FilledButton(onPressed: onContinue, child: const Text('Continue')),
      ],
    );
  }
}

class _WifiStep extends StatelessWidget {
  const _WifiStep({
    required this.ssidController,
    required this.passwordController,
    required this.busy,
    required this.statusText,
    required this.onProvision,
  });

  final TextEditingController ssidController;
  final TextEditingController passwordController;
  final bool busy;
  final String? statusText;
  final VoidCallback onProvision;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          'Connect to your WiFi',
          style: Theme.of(context).textTheme.headlineSmall,
        ),
        const SizedBox(height: Spacing.sm),
        const Text(
          'Make sure your phone is still connected to the '
          "device's temporary network, then enter your home WiFi details.",
        ),
        const SizedBox(height: Spacing.lg),
        TextField(
          controller: ssidController,
          decoration: const InputDecoration(labelText: 'WiFi network name'),
          autocorrect: false,
        ),
        const SizedBox(height: Spacing.sm),
        TextField(
          controller: passwordController,
          decoration: const InputDecoration(labelText: 'WiFi password'),
          obscureText: true,
        ),
        const SizedBox(height: Spacing.lg),
        FilledButton(
          onPressed: busy ? null : onProvision,
          child: busy
              ? const SizedBox(
                  width: 20,
                  height: 20,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Text('Connect'),
        ),
        if (statusText != null)
          Padding(
            padding: const EdgeInsets.only(top: Spacing.sm),
            child: Text(statusText!),
          ),
      ],
    );
  }
}

class _FindDeviceStep extends StatelessWidget {
  const _FindDeviceStep({
    required this.busy,
    required this.statusText,
    required this.ipController,
    required this.onRetry,
    required this.onUseManualIp,
  });

  final bool busy;
  final String? statusText;
  final TextEditingController ipController;
  final VoidCallback onRetry;
  final VoidCallback onUseManualIp;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          'Finding your device',
          style: Theme.of(context).textTheme.headlineSmall,
        ),
        const SizedBox(height: Spacing.sm),
        if (busy)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: Spacing.lg),
            child: Center(child: CircularProgressIndicator()),
          ),
        if (statusText != null)
          Padding(
            padding: const EdgeInsets.only(bottom: Spacing.md),
            child: Text(statusText!, textAlign: TextAlign.center),
          ),
        if (!busy) ...[
          FilledButton(onPressed: onRetry, child: const Text('Search again')),
          const SizedBox(height: Spacing.lg),
          const Text('Still nothing? Enter its IP address manually:'),
          const SizedBox(height: Spacing.sm),
          TextField(
            controller: ipController,
            decoration: const InputDecoration(
              labelText: 'Device IP address',
              hintText: 'e.g. 192.168.1.42',
            ),
            keyboardType: TextInputType.number,
            autocorrect: false,
          ),
          const SizedBox(height: Spacing.sm),
          FilledButton.tonal(
            onPressed: onUseManualIp,
            child: const Text('Use this address'),
          ),
        ],
      ],
    );
  }
}

class _RoomStep extends StatelessWidget {
  const _RoomStep({
    required this.roomController,
    required this.busy,
    required this.onContinue,
  });

  final TextEditingController roomController;
  final bool busy;
  final VoidCallback onContinue;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('Choose a room', style: Theme.of(context).textTheme.headlineSmall),
        const SizedBox(height: Spacing.sm),
        const Text(
          'This groups the switch under Rooms. You can change it later.',
        ),
        const SizedBox(height: Spacing.lg),
        TextField(
          controller: roomController,
          decoration: const InputDecoration(
            labelText: 'Room (optional)',
            hintText: 'e.g. Living Room',
          ),
        ),
        const SizedBox(height: Spacing.lg),
        FilledButton(
          onPressed: busy ? null : onContinue,
          child: busy
              ? const SizedBox(
                  width: 20,
                  height: 20,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Text('Continue'),
        ),
      ],
    );
  }
}

class _NameStep extends StatelessWidget {
  const _NameStep({required this.nameController, required this.onContinue});

  final TextEditingController nameController;
  final VoidCallback onContinue;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          'Name your switch',
          style: Theme.of(context).textTheme.headlineSmall,
        ),
        const SizedBox(height: Spacing.lg),
        TextField(
          controller: nameController,
          decoration: const InputDecoration(labelText: 'Device name'),
        ),
        const SizedBox(height: Spacing.lg),
        FilledButton(onPressed: onContinue, child: const Text('Continue')),
      ],
    );
  }
}

class _DoneStep extends StatelessWidget {
  const _DoneStep({required this.onDone});

  final VoidCallback onDone;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Icon(
          Icons.celebration,
          size: 64,
          color: Theme.of(context).colorScheme.primary,
        ),
        const SizedBox(height: Spacing.md),
        Text(
          "You're all set!",
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.headlineSmall,
        ),
        const SizedBox(height: Spacing.lg),
        FilledButton(onPressed: onDone, child: const Text('Done')),
      ],
    );
  }
}

class _QrScanPage extends StatefulWidget {
  const _QrScanPage();

  @override
  State<_QrScanPage> createState() => _QrScanPageState();
}

class _QrScanPageState extends State<_QrScanPage> {
  final _controller = MobileScannerController();
  bool _handled = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _onDetect(BarcodeCapture capture) {
    if (_handled) {
      return;
    }
    for (final barcode in capture.barcodes) {
      final raw = barcode.rawValue;
      if (raw == null) {
        continue;
      }
      final parsed = parseDeviceSetupUri(raw);
      if (parsed != null) {
        _handled = true;
        Navigator.of(context).pop(parsed);
        return;
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Scan QR code')),
      body: MobileScanner(controller: _controller, onDetect: _onDetect),
    );
  }
}
