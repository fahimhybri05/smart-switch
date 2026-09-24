import 'dart:convert';
import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_animate/flutter_animate.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../models/device/device_config.dart';
import '../../models/local/known_device.dart';
import '../../providers/service_providers.dart';
import '../../routing/app_routes.dart';
import '../../services/backend/backend_api_exception.dart';
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

typedef DeviceSettingsDialogResult = ({
  bool interlockEnabled,
  double? latitude,
  double? longitude,
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

  /// Unclaims the device from the account first (so it doesn't just
  /// reappear on the next [syncClaimedDevicesFromBackend]/pull-to-refresh
  /// on this or any other phone signed into the same account), then
  /// removes it from this phone's local registry. Only actually removed
  /// locally once the account side is confirmed gone — a device that was
  /// never cloud-claimed (404) still counts as "gone" for this purpose.
  Future<void> _removeDevice(
    BuildContext context,
    WidgetRef ref,
    KnownDevice device,
  ) async {
    if (ref.read(authProvider) != null &&
        ref.read(backendUrlProvider) != null) {
      try {
        final accessToken = await ensureFreshAccessToken(ref);
        await BackendDevicesClient(
          baseUrl: ref.read(backendUrlProvider)!,
          accessToken: accessToken,
        ).unclaim(device.deviceId);
      } on BackendApiException catch (e) {
        if (e.statusCode != 404) {
          if (context.mounted) {
            ScaffoldMessenger.of(
              context,
            ).showSnackBar(SnackBar(content: Text(e.message)));
          }
          return;
        }
      } catch (_) {
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text(
                'Could not reach the server to remove this device from '
                'your account. Check your connection and try again.',
              ),
            ),
          );
        }
        return;
      }
    }

    await ref.read(knownDevicesProvider.notifier).remove(device.deviceId);
    if (context.mounted) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('Device removed')));
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

  Future<void> _editDeviceSettings(
    BuildContext context,
    WidgetRef ref,
    KnownDevice device,
  ) async {
    DeviceConfig config;
    try {
      config = await ref
          .read(activeDeviceApiClientProvider(device))
          .getConfig();
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Failed to load: $e')));
      }
      return;
    }
    if (!context.mounted) return;

    final result = await showDialog<DeviceSettingsDialogResult>(
      context: context,
      builder: (context) => _DeviceSettingsDialog(
        deviceName: device.friendlyName,
        config: config,
      ),
    );
    if (result == null) return;

    try {
      await ref
          .read(activeDeviceApiClientProvider(device))
          .setDeviceSettings(
            interlockEnabled: result.interlockEnabled,
            latitude: result.latitude,
            longitude: result.longitude,
          );
      ref.invalidate(deviceConfigProvider(device));
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Device settings updated')),
        );
      }
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Failed: $e')));
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
          if (_showCloudAndBackup) ...[
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
          ],
          const _SectionHeader(
            icon: Icons.family_restroom_outlined,
            label: 'Household',
          ),
          Card(
            child: Column(
              children: [
                ListTile(
                  leading: const _RowIconBox(Icons.family_restroom_outlined),
                  title: const Text('Manage household'),
                  subtitle: const Text('Who can see and control your devices'),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () =>
                      Navigator.of(context).pushNamed(AppRoutes.household),
                ),
                const Divider(height: 1),
                ListTile(
                  leading: const _RowIconBox(Icons.history_outlined),
                  title: const Text('Activity history'),
                  subtitle: const Text('Every switch on/off event'),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () =>
                      Navigator.of(context).pushNamed(AppRoutes.activity),
                ),
                const Divider(height: 1),
                ListTile(
                  leading: const _RowIconBox(Icons.bolt_outlined),
                  title: const Text('Automations'),
                  subtitle: const Text('Rules that run on their own'),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () =>
                      Navigator.of(context).pushNamed(AppRoutes.automations),
                ),
                const Divider(height: 1),
                ListTile(
                  leading: const _RowIconBox(Icons.auto_awesome_outlined),
                  title: const Text('Scenes'),
                  subtitle: const Text('Set several switches with one tap'),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () =>
                      Navigator.of(context).pushNamed(AppRoutes.scenes),
                ),
                const Divider(height: 1),
                ListTile(
                  leading: const _RowIconBox(Icons.insights_outlined),
                  title: const Text('Usage'),
                  subtitle: const Text('On time and energy per switch'),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => Navigator.of(context).pushNamed(AppRoutes.usage),
                ),
              ],
            ),
          ),
          const _SectionHeader(
            icon: Icons.developer_board_outlined,
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
                  leading: _RowIconBox(
                    Icons.developer_board_outlined,
                    color: colorScheme.primary,
                  ),
                  title: InkWell(
                    onTap: () => _renameDevice(context, ref, device),
                    child: Text(
                      device.friendlyName,
                      style: Theme.of(context).textTheme.titleSmall,
                    ),
                  ),
                  subtitle: Text(
                    device.lastKnownIp == null
                        ? '${device.deviceId} — not found on this network yet'
                        : '${device.deviceId} — ${device.lastKnownIp}',
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: colorScheme.onSurfaceVariant,
                    ),
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
                        case 'device_settings':
                          await _editDeviceSettings(context, ref, device);
                        case 'remove':
                          final confirmed = await showDialog<bool>(
                            context: context,
                            builder: (context) => AlertDialog(
                              icon: Icon(
                                Icons.warning_amber_rounded,
                                color: Theme.of(context).colorScheme.error,
                              ),
                              title: const Text('Remove device?'),
                              content: Text(
                                'Remove "${device.friendlyName}" from your account? '
                                'Every phone signed into this account will lose access, '
                                'and it will need to be added again to reconnect. '
                                'The device itself is unaffected.',
                              ),
                              actions: [
                                TextButton(
                                  onPressed: () =>
                                      Navigator.of(context).pop(false),
                                  child: const Text('Cancel'),
                                ),
                                FilledButton(
                                  style: FilledButton.styleFrom(
                                    backgroundColor: Theme.of(
                                      context,
                                    ).colorScheme.error,
                                    foregroundColor: Theme.of(
                                      context,
                                    ).colorScheme.onError,
                                  ),
                                  onPressed: () =>
                                      Navigator.of(context).pop(true),
                                  child: const Text('Remove'),
                                ),
                              ],
                            ),
                          );
                          if ((confirmed ?? false) && context.mounted) {
                            await _removeDevice(context, ref, device);
                          }
                      }
                    },
                    itemBuilder: (context) => [
                      const PopupMenuItem(
                        value: 'remote',
                        child: _MenuRow(
                          icon: Icons.settings_remote_outlined,
                          label: 'Enable remote control',
                        ),
                      ),
                      const PopupMenuItem(
                        value: 'timezone',
                        child: _MenuRow(
                          icon: Icons.schedule_outlined,
                          label: 'Timezone',
                        ),
                      ),
                      const PopupMenuItem(
                        value: 'network',
                        child: _MenuRow(
                          icon: Icons.wifi_outlined,
                          label: 'Network settings',
                        ),
                      ),
                      const PopupMenuItem(
                        value: 'device_settings',
                        child: _MenuRow(
                          icon: Icons.tune_outlined,
                          label: 'Interlock & location',
                        ),
                      ),
                      const PopupMenuDivider(),
                      PopupMenuItem(
                        value: 'remove',
                        child: _MenuRow(
                          icon: Icons.delete_outline,
                          label: 'Remove device',
                          color: Theme.of(context).colorScheme.error,
                        ),
                      ),
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
              leading: const _RowIconBox(Icons.widgets_outlined),
              title: const Text('Pinned switches'),
              subtitle: const Text(
                'Choose switches for the home-screen widgets',
              ),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => showPinnedSwitchesDialog(context),
            ),
          ),
          if (_showCloudAndBackup) ...[
            const _SectionHeader(icon: Icons.backup_outlined, label: 'Backup'),
            Card(
              child: Column(
                children: [
                  ListTile(
                    leading: const _RowIconBox(Icons.upload_outlined),
                    title: const Text('Export backup'),
                    subtitle: const Text(
                      'Known devices, groups, and a config snapshot',
                    ),
                    onTap: () => _exportBackup(context, ref),
                  ),
                  const Divider(height: 1),
                  ListTile(
                    leading: const _RowIconBox(Icons.download_outlined),
                    title: const Text('Import backup'),
                    subtitle: const Text('Restores known devices and groups'),
                    onTap: () => _importBackup(context, ref),
                  ),
                ],
              ),
            ),
          ],
          // The cloud account card (hidden above) is where Log out normally
          // lives — keep sign-out reachable while it's hidden.
          if (!_showCloudAndBackup && ref.watch(authProvider) != null) ...[
            const SizedBox(height: Spacing.md),
            Card(
              child: ListTile(
                leading: Icon(Icons.logout_rounded, color: colorScheme.error),
                title: Text(
                  'Log out',
                  style: TextStyle(color: colorScheme.error),
                ),
                subtitle: Text(ref.watch(authProvider)!.email),
                onTap: () => ref.read(authProvider.notifier).logout(),
              ),
            ),
          ],
          const SizedBox(height: Spacing.lg),
        ],
      ),
    );
  }
}

// Cloud account + Backup sections are hidden for now; flip to bring them back.
const _showCloudAndBackup = false;

/// Icon + label used inside a [PopupMenuItem] — gives the known-devices
/// overflow menu the same icon-led weight as the rest of the settings list
/// instead of a plain text menu.
class _MenuRow extends StatelessWidget {
  const _MenuRow({required this.icon, required this.label, this.color});

  final IconData icon;
  final String label;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final iconColor = color ?? Theme.of(context).colorScheme.primary;
    return Row(
      children: [
        Icon(icon, size: 19, color: iconColor),
        const SizedBox(width: Spacing.sm),
        Text(label, style: color == null ? null : TextStyle(color: color)),
      ],
    );
  }
}

/// Small tonal icon badge used as the leading element on this screen's
/// plain nav rows, in place of a bare [Icon] floating on the tile — a
/// standard Material 3 tonal-fill treatment, no border.
class _RowIconBox extends StatelessWidget {
  const _RowIconBox(this.icon, {this.color});

  final IconData icon;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    final tint = color ?? colorScheme.primary;
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
            Spacing.lg,
            Spacing.md,
            Spacing.xs,
          ),
          child: Row(
            children: [
              Icon(icon, size: 16, color: colorScheme.primary),
              const SizedBox(width: Spacing.xs),
              Text(
                label,
                style: Theme.of(context).textTheme.labelLarge?.copyWith(
                  color: colorScheme.onSurfaceVariant,
                  fontWeight: FontWeight.w600,
                ),
              ),
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
                  _RowIconBox(
                    Icons.verified_user_outlined,
                    color: Theme.of(context).colorScheme.tertiary,
                  ),
                  const SizedBox(width: Spacing.sm),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          auth!.email,
                          style: Theme.of(context).textTheme.titleSmall,
                        ),
                        Text(
                          'Signed in',
                          style: Theme.of(context).textTheme.bodySmall
                              ?.copyWith(
                                color: Theme.of(
                                  context,
                                ).colorScheme.onSurfaceVariant,
                              ),
                        ),
                      ],
                    ),
                  ),
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
  final _formKey = GlobalKey<FormState>();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  // Empty is allowed (clears the backend URL); anything else must be a
  // well-formed http(s) URL so a typo surfaces here instead of as a
  // confusing connection failure later.
  String? _validate(String? value) {
    final text = (value ?? '').trim();
    if (text.isEmpty) {
      return null;
    }
    if (!text.startsWith('http://') && !text.startsWith('https://')) {
      return 'Must start with http:// or https://';
    }
    final uri = Uri.tryParse(text);
    if (uri == null || uri.host.isEmpty) {
      return 'Enter a valid URL';
    }
    return null;
  }

  void _submit(String value) {
    if (_formKey.currentState?.validate() ?? false) {
      widget.onSubmitted(value);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Form(
      key: _formKey,
      child: TextFormField(
        controller: _controller,
        decoration: InputDecoration(
          labelText: 'Backend server URL',
          hintText: 'https://switch.example.com',
          suffixIcon: IconButton(
            icon: const Icon(Icons.check),
            tooltip: 'Save',
            onPressed: () => _submit(_controller.text),
          ),
        ),
        keyboardType: TextInputType.url,
        autocorrect: false,
        autovalidateMode: AutovalidateMode.onUserInteraction,
        validator: _validate,
        onFieldSubmitted: _submit,
      ),
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
  final _formKey = GlobalKey<FormState>();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  // Real-world UTC offsets range from -12:00 to +14:00.
  String? _validate(String? value) {
    final parsed = int.tryParse((value ?? '').trim());
    if (parsed == null) {
      return 'Enter a whole number of minutes';
    }
    if (parsed < -720 || parsed > 840) {
      return 'Offset must be between -720 and 840';
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text('${widget.deviceName} timezone'),
      content: Form(
        key: _formKey,
        child: TextFormField(
          controller: _controller,
          autofocus: true,
          keyboardType: const TextInputType.numberWithOptions(signed: true),
          decoration: const InputDecoration(
            labelText: 'UTC offset (minutes)',
            helperText: 'e.g. 330 for IST, -300 for EST',
          ),
          validator: _validate,
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () {
            if (!(_formKey.currentState?.validate() ?? false)) {
              return;
            }
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

class _DeviceSettingsDialog extends StatefulWidget {
  const _DeviceSettingsDialog({required this.deviceName, required this.config});

  final String deviceName;
  final DeviceConfig config;

  @override
  State<_DeviceSettingsDialog> createState() => _DeviceSettingsDialogState();
}

class _DeviceSettingsDialogState extends State<_DeviceSettingsDialog> {
  late bool _interlockEnabled = widget.config.interlockEnabled;
  late final _latController = TextEditingController(
    text: widget.config.locationSet ? widget.config.latitude.toString() : '',
  );
  late final _lonController = TextEditingController(
    text: widget.config.locationSet ? widget.config.longitude.toString() : '',
  );

  @override
  void dispose() {
    _latController.dispose();
    _lonController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text('${widget.deviceName} settings'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('Interlock mode'),
              subtitle: const Text(
                'Turning any channel ON forces every other channel OFF',
              ),
              value: _interlockEnabled,
              onChanged: (v) => setState(() => _interlockEnabled = v),
            ),
            const SizedBox(height: 12),
            Text(
              'Location (for sunrise/sunset schedules)',
              style: Theme.of(context).textTheme.labelLarge,
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _latController,
              decoration: const InputDecoration(
                labelText: 'Latitude',
                hintText: '-90 to 90',
              ),
              keyboardType: const TextInputType.numberWithOptions(
                decimal: true,
                signed: true,
              ),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _lonController,
              decoration: const InputDecoration(
                labelText: 'Longitude',
                hintText: '-180 to 180',
              ),
              keyboardType: const TextInputType.numberWithOptions(
                decimal: true,
                signed: true,
              ),
            ),
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
            final latText = _latController.text.trim();
            final lonText = _lonController.text.trim();
            if (latText.isEmpty != lonText.isEmpty) {
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(
                  content: Text(
                    'Set both latitude and longitude, or leave both blank',
                  ),
                ),
              );
              return;
            }
            double? lat, lon;
            if (latText.isNotEmpty) {
              lat = double.tryParse(latText);
              lon = double.tryParse(lonText);
              if (lat == null ||
                  lon == null ||
                  lat < -90 ||
                  lat > 90 ||
                  lon < -180 ||
                  lon > 180) {
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(
                    content: Text(
                      'Latitude must be -90..90 and longitude -180..180',
                    ),
                  ),
                );
                return;
              }
            }
            Navigator.of(context).pop((
              interlockEnabled: _interlockEnabled,
              latitude: lat,
              longitude: lon,
            ));
          },
          child: const Text('Save'),
        ),
      ],
    );
  }
}
