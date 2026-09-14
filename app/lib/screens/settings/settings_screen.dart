import 'dart:convert';
import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_animate/flutter_animate.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/local/known_device.dart';
import '../../providers/service_providers.dart';
import '../../routing/app_routes.dart';
import '../../services/backend/backend_devices_client.dart';
import '../../theme/motion.dart';
import '../../theme/spacing.dart';
import '../shared/pinned_switches_dialog.dart';

typedef NetworkDialogResult = ({
  String mode,
  String? ip,
  String? gateway,
  String? subnet,
  String? dns,
});

class SettingsScreen extends ConsumerWidget {
  const SettingsScreen({super.key});

  Future<void> _exportBackup(BuildContext context, WidgetRef ref) async {
    try {
      final json = await exportBackup(ref);
      final uri = await FilePicker.saveFile(
        fileName: 'smart_switch_backup.json',
        bytes: Uint8List.fromList(utf8.encode(json)),
        mimeType: 'application/json',
      );
      if (context.mounted && uri != null) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(const SnackBar(content: Text('Backup exported')));
      }
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Export failed: $e')));
      }
    }
  }

  Future<void> _importBackup(BuildContext context, WidgetRef ref) async {
    final picked = await FilePicker.pickFile(
      type: FileType.custom,
      allowedExtensions: ['json'],
    );
    if (picked == null) {
      return;
    }
    try {
      final content = await picked.xFile.readAsString();
      await importBackup(ref, content);
      if (context.mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(const SnackBar(content: Text('Backup imported')));
      }
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Import failed: $e')));
      }
    }
  }

  Future<void> _renameDevice(
    BuildContext context,
    WidgetRef ref,
    KnownDevice device,
  ) async {
    final name = await showDialog<String>(
      context: context,
      builder: (context) => _RenameDialog(initial: device.friendlyName),
    );
    if (name == null || name == device.friendlyName) {
      return;
    }

    await ref
        .read(knownDevicesProvider.notifier)
        .upsert(device.copyWith(friendlyName: name));

    // Best-effort: propagate to the account so every other phone logged
    // into it sees the new name too (see docs/plan.md's account-wide sync
    // section). A 404 here just means this device was never cloud-claimed
    // — the local rename above still applies either way.
    if (ref.read(authProvider) != null &&
        ref.read(backendUrlProvider) != null) {
      try {
        final accessToken = await ensureFreshAccessToken(ref);
        await BackendDevicesClient(
          baseUrl: ref.read(backendUrlProvider)!,
          accessToken: accessToken,
        ).rename(device.deviceId, name);
      } catch (_) {}
    }

    if (context.mounted) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('Renamed')));
    }
  }

  Future<void> _editTimezone(
    BuildContext context,
    WidgetRef ref,
    KnownDevice device,
  ) async {
    final offset = await showDialog<int>(
      context: context,
      builder: (context) => _TimezoneDialog(deviceName: device.friendlyName),
    );
    if (offset == null) {
      return;
    }
    try {
      await ref.read(activeDeviceApiClientProvider(device)).setTimezone(offset);
      if (context.mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(const SnackBar(content: Text('Timezone updated')));
      }
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Failed: $e')));
      }
    }
  }

  Future<void> _editNetwork(
    BuildContext context,
    WidgetRef ref,
    KnownDevice device,
  ) async {
    final result = await showDialog<NetworkDialogResult>(
      context: context,
      builder: (context) => _NetworkDialog(deviceName: device.friendlyName),
    );
    if (result == null) {
      return;
    }
    try {
      await ref
          .read(activeDeviceApiClientProvider(device))
          .setNetworkConfig(
            mode: result.mode,
            ip: result.ip,
            gateway: result.gateway,
            subnet: result.subnet,
            dns: result.dns,
          );
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Network updated — device is rebooting'),
          ),
        );
      }
    } catch (e) {
      // The device reboots right after responding, so a dropped-connection
      // error here is often just the reboot itself, not a real failure —
      // say so rather than implying the change didn't take.
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              "Request didn't complete cleanly ($e) — the device may still "
              'have applied it (it reboots right away). Check Known '
              "devices' address in a few seconds.",
            ),
          ),
        );
      }
    }
  }

  Future<void> _enableRemoteControl(
    BuildContext context,
    WidgetRef ref,
    KnownDevice device,
  ) async {
    if (ref.read(authProvider) == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Log in under Cloud account first')),
      );
      return;
    }
    final backendUrl = ref.read(backendUrlProvider);
    if (backendUrl == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Set a backend server URL first')),
      );
      return;
    }

    try {
      final info = await ref
          .read(activeDeviceApiClientProvider(device))
          .getInfo();
      final cloudSecret = info.cloudSecret;
      if (cloudSecret == null) {
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text(
                "This device doesn't support remote control yet — update its firmware.",
              ),
            ),
          );
        }
        return;
      }

      final accessToken = await ensureFreshAccessToken(ref);
      await BackendDevicesClient(
        baseUrl: backendUrl,
        accessToken: accessToken,
      ).claim(
        deviceId: device.deviceId,
        cloudSecret: cloudSecret,
        friendlyName: device.friendlyName,
      );
      if (context.mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(const SnackBar(content: Text('Remote control enabled')));
      }
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Failed: $e')));
      }
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final devices = ref.watch(knownDevicesProvider);
    final colorScheme = Theme.of(context).colorScheme;

    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: ListView(
        padding: const EdgeInsets.symmetric(vertical: Spacing.sm),
        children: [
          const _SectionHeader(
            icon: Icons.palette_outlined,
            label: 'Appearance',
          ),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(Spacing.md),
              child: SegmentedButton<ThemeMode>(
                segments: const [
                  ButtonSegment(
                    value: ThemeMode.light,
                    icon: Icon(Icons.light_mode_outlined),
                    label: Text('Light'),
                  ),
                  ButtonSegment(
                    value: ThemeMode.dark,
                    icon: Icon(Icons.dark_mode_outlined),
                    label: Text('Dark'),
                  ),
                  ButtonSegment(
                    value: ThemeMode.system,
                    icon: Icon(Icons.brightness_auto_outlined),
                    label: Text('System'),
                  ),
                ],
                selected: {ref.watch(themeModeProvider)},
                onSelectionChanged: (selection) => ref
                    .read(themeModeProvider.notifier)
                    .setThemeMode(selection.first),
              ),
            ),
          ),
          const _SectionHeader(
            icon: Icons.cloud_outlined,
            label: 'Cloud account',
          ),
          _CloudAccountCard(
            auth: ref.watch(authProvider),
            backendUrl: ref.watch(backendUrlProvider),
            onSetBackendUrl: (url) =>
                ref.read(backendUrlProvider.notifier).setBackendUrl(url),
            onLogin: () => Navigator.of(context).pushNamed(AppRoutes.login),
            onSignup: () => Navigator.of(context).pushNamed(AppRoutes.signup),
            onLogout: () => ref.read(authProvider.notifier).logout(),
          ),
          const _SectionHeader(
            icon: Icons.family_restroom_outlined,
            label: 'Household',
          ),
          Card(
            child: Column(
              children: [
                ListTile(
                  leading: const Icon(Icons.family_restroom_outlined),
                  title: const Text('Manage household'),
                  subtitle: const Text(
                    'Who can see and control your devices',
                  ),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () =>
                      Navigator.of(context).pushNamed(AppRoutes.household),
                ),
                const Divider(height: 1),
                ListTile(
                  leading: const Icon(Icons.history_outlined),
                  title: const Text('Activity history'),
                  subtitle: const Text('Every switch on/off event'),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () =>
                      Navigator.of(context).pushNamed(AppRoutes.activity),
                ),
                const Divider(height: 1),
                ListTile(
                  leading: const Icon(Icons.bolt_outlined),
                  title: const Text('Automations'),
                  subtitle: const Text('Rules that run on their own'),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () =>
                      Navigator.of(context).pushNamed(AppRoutes.automations),
                ),
              ],
            ),
          ),
          const _SectionHeader(
            icon: Icons.devices_other,
            label: 'Known devices',
          ),
          if (devices.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(horizontal: Spacing.md),
              child: Text('No devices yet.'),
            )
          else
            for (final device in devices)
              Card(
                child: ListTile(
                  leading: CircleAvatar(
                    backgroundColor: colorScheme.primaryContainer,
                    child: Icon(
                      Icons.developer_board,
                      color: colorScheme.onPrimaryContainer,
                    ),
                  ),
                  title: InkWell(
                    onTap: () => _renameDevice(context, ref, device),
                    child: Text(device.friendlyName),
                  ),
                  subtitle: Text(
                    device.lastKnownIp == null
                        ? '${device.deviceId} — not found on this network yet'
                        : '${device.deviceId} — ${device.lastKnownIp}',
                  ),
                  trailing: PopupMenuButton<String>(
                    icon: const Icon(Icons.more_horiz_rounded),
                    onSelected: (action) async {
                      switch (action) {
                        case 'remote':
                          await _enableRemoteControl(context, ref, device);
                        case 'timezone':
                          await _editTimezone(context, ref, device);
                        case 'network':
                          await _editNetwork(context, ref, device);
                        case 'remove':
                          final confirmed = await showDialog<bool>(
                            context: context,
                            builder: (context) => AlertDialog(
                              title: const Text('Remove device?'),
                              content: Text(
                                'Remove "${device.friendlyName}" from this phone? The device itself is unaffected.',
                              ),
                              actions: [
                                TextButton(
                                  onPressed: () =>
                                      Navigator.of(context).pop(false),
                                  child: const Text('Cancel'),
                                ),
                                FilledButton(
                                  onPressed: () =>
                                      Navigator.of(context).pop(true),
                                  child: const Text('Remove'),
                                ),
                              ],
                            ),
                          );
                          if (confirmed ?? false) {
                            await ref
                                .read(knownDevicesProvider.notifier)
                                .remove(device.deviceId);
                          }
                      }
                    },
                    itemBuilder: (context) => const [
                      PopupMenuItem(
                        value: 'remote',
                        child: Text('Enable remote control'),
                      ),
                      PopupMenuItem(value: 'timezone', child: Text('Timezone')),
                      PopupMenuItem(
                        value: 'network',
                        child: Text('Network settings'),
                      ),
                      PopupMenuDivider(),
                      PopupMenuItem(value: 'remove', child: Text('Remove device')),
                    ],
                  ),
                ),
              ),
          const _SectionHeader(
            icon: Icons.widgets_outlined,
            label: 'Home screen widget',
          ),
          Card(
            child: ListTile(
              leading: const Icon(Icons.widgets_outlined),
              title: const Text('Pinned switches'),
              subtitle: const Text('Choose up to 4 switches to pin (Android)'),
              onTap: () => showPinnedSwitchesDialog(context),
            ),
          ),
          const _SectionHeader(icon: Icons.backup_outlined, label: 'Backup'),
          Card(
            child: Column(
              children: [
                ListTile(
                  leading: const Icon(Icons.upload_outlined),
                  title: const Text('Export backup'),
                  subtitle: const Text(
                    'Known devices, groups, and a config snapshot',
                  ),
                  onTap: () => _exportBackup(context, ref),
                ),
                const Divider(height: 1),
                ListTile(
                  leading: const Icon(Icons.download_outlined),
                  title: const Text('Import backup'),
                  subtitle: const Text('Restores known devices and groups'),
                  onTap: () => _importBackup(context, ref),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(vertical: Spacing.lg),
            child: Center(
              child: Text(
                'Smart Switch — serverless ESP32/8266 relay control.\nVersion 1.0.0',
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontSize: 12,
                  color: colorScheme.onSurfaceVariant,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _SectionHeader extends StatelessWidget {
  const _SectionHeader({required this.icon, required this.label});

  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return Padding(
          padding: const EdgeInsetsDirectional.fromSTEB(
            Spacing.md,
            Spacing.md,
            Spacing.md,
            Spacing.xs,
          ),
          child: Row(
            children: [
              Icon(icon, size: 18, color: colorScheme.onSurfaceVariant),
              const SizedBox(width: Spacing.xs),
              Text(label, style: Theme.of(context).textTheme.titleMedium),
            ],
          ),
        )
        .animate()
        .fadeIn(duration: Motion.medium, curve: Motion.standard)
        .slideY(
          begin: 0.15,
          end: 0,
          duration: Motion.medium,
          curve: Motion.standard,
        );
  }
}

class _CloudAccountCard extends StatelessWidget {
  const _CloudAccountCard({
    required this.auth,
    required this.backendUrl,
    required this.onSetBackendUrl,
    required this.onLogin,
    required this.onSignup,
    required this.onLogout,
  });

  final AuthState auth;
  final String? backendUrl;
  final ValueChanged<String> onSetBackendUrl;
  final VoidCallback onLogin;
  final VoidCallback onSignup;
  final VoidCallback onLogout;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(Spacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _BackendUrlField(
              initialValue: backendUrl,
              onSubmitted: onSetBackendUrl,
            ),
            const SizedBox(height: Spacing.sm),
            if (auth == null)
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton(
                      onPressed: onLogin,
                      child: const Text('Log in'),
                    ),
                  ),
                  const SizedBox(width: Spacing.sm),
                  Expanded(
                    child: FilledButton(
                      onPressed: onSignup,
                      child: const Text('Sign up'),
                    ),
                  ),
                ],
              )
            else
              Row(
                children: [
                  Expanded(child: Text(auth!.email)),
                  TextButton(onPressed: onLogout, child: const Text('Log out')),
                ],
              ),
          ],
        ),
      ),
    );
  }
}

class _BackendUrlField extends StatefulWidget {
  const _BackendUrlField({
    required this.initialValue,
    required this.onSubmitted,
  });

  final String? initialValue;
  final ValueChanged<String> onSubmitted;

  @override
  State<_BackendUrlField> createState() => _BackendUrlFieldState();
}

class _BackendUrlFieldState extends State<_BackendUrlField> {
  late final TextEditingController _controller = TextEditingController(
    text: widget.initialValue ?? '',
  );

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return TextField(
      controller: _controller,
      decoration: InputDecoration(
        labelText: 'Backend server URL',
        hintText: 'https://switch.example.com',
        suffixIcon: IconButton(
          icon: const Icon(Icons.check),
          tooltip: 'Save',
          onPressed: () => widget.onSubmitted(_controller.text),
        ),
      ),
      keyboardType: TextInputType.url,
      autocorrect: false,
      onSubmitted: widget.onSubmitted,
    );
  }
}

class _RenameDialog extends StatefulWidget {
  const _RenameDialog({required this.initial});

  final String initial;

  @override
  State<_RenameDialog> createState() => _RenameDialogState();
}

class _RenameDialogState extends State<_RenameDialog> {
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
      title: const Text('Rename device'),
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
          child: const Text('Save'),
        ),
      ],
    );
  }
}

class _TimezoneDialog extends StatefulWidget {
  const _TimezoneDialog({required this.deviceName});

  final String deviceName;

  @override
  State<_TimezoneDialog> createState() => _TimezoneDialogState();
}

class _TimezoneDialogState extends State<_TimezoneDialog> {
  late final TextEditingController _controller = TextEditingController(
    text: '${DateTime.now().timeZoneOffset.inMinutes}',
  );

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text('${widget.deviceName} timezone'),
      content: TextField(
        controller: _controller,
        autofocus: true,
        keyboardType: const TextInputType.numberWithOptions(signed: true),
        decoration: const InputDecoration(
          labelText: 'UTC offset (minutes)',
          helperText: 'e.g. 330 for IST, -300 for EST',
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () {
            final value = int.tryParse(_controller.text.trim());
            Navigator.of(context).pop(value);
          },
          child: const Text('Save'),
        ),
      ],
    );
  }
}

class _NetworkDialog extends StatefulWidget {
  const _NetworkDialog({required this.deviceName});

  final String deviceName;

  @override
  State<_NetworkDialog> createState() => _NetworkDialogState();
}

class _NetworkDialogState extends State<_NetworkDialog> {
  String _mode = 'dhcp';
  final _ipController = TextEditingController();
  final _gatewayController = TextEditingController();
  final _subnetController = TextEditingController(text: '255.255.255.0');
  final _dnsController = TextEditingController();

  @override
  void dispose() {
    _ipController.dispose();
    _gatewayController.dispose();
    _subnetController.dispose();
    _dnsController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text('${widget.deviceName} network'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SegmentedButton<String>(
              segments: const [
                ButtonSegment(value: 'dhcp', label: Text('DHCP')),
                ButtonSegment(value: 'static', label: Text('Static IP')),
              ],
              selected: {_mode},
              onSelectionChanged: (selection) =>
                  setState(() => _mode = selection.first),
            ),
            if (_mode == 'static') ...[
              const SizedBox(height: 12),
              TextField(
                controller: _ipController,
                decoration: const InputDecoration(
                  labelText: 'IP address',
                  hintText: 'e.g. 192.168.1.50',
                ),
                keyboardType: TextInputType.number,
              ),
              const SizedBox(height: 8),
              TextField(
                controller: _gatewayController,
                decoration: const InputDecoration(
                  labelText: 'Gateway',
                  hintText: 'e.g. 192.168.1.1',
                ),
                keyboardType: TextInputType.number,
              ),
              const SizedBox(height: 8),
              TextField(
                controller: _subnetController,
                decoration: const InputDecoration(labelText: 'Subnet mask'),
                keyboardType: TextInputType.number,
              ),
              const SizedBox(height: 8),
              TextField(
                controller: _dnsController,
                decoration: const InputDecoration(
                  labelText: 'DNS (optional)',
                  hintText: 'defaults to gateway',
                ),
                keyboardType: TextInputType.number,
              ),
            ],
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () {
            if (_mode == 'dhcp') {
              Navigator.of(context).pop((
                mode: 'dhcp',
                ip: null,
                gateway: null,
                subnet: null,
                dns: null,
              ));
              return;
            }
            final ip = _ipController.text.trim();
            final gateway = _gatewayController.text.trim();
            final subnet = _subnetController.text.trim();
            if (ip.isEmpty || gateway.isEmpty || subnet.isEmpty) {
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(
                  content: Text('IP address, gateway, and subnet are required'),
                ),
              );
              return;
            }
            final dns = _dnsController.text.trim();
            Navigator.of(context).pop((
              mode: 'static',
              ip: ip,
              gateway: gateway,
              subnet: subnet,
              dns: dns.isEmpty ? null : dns,
            ));
          },
          child: const Text('Save'),
        ),
      ],
    );
  }
}
