import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:package_info_plus/package_info_plus.dart';

import '../../providers/service_providers.dart';
import '../../theme/spacing.dart';

final _packageInfoProvider = FutureProvider<PackageInfo>(
  (ref) => PackageInfo.fromPlatform(),
);

/// Settings › About: app version, which server it talks to, and licenses.
class AboutScreen extends ConsumerWidget {
  const AboutScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    final info = ref.watch(_packageInfoProvider).asData?.value;
    final server = ref.watch(backendUrlProvider) ?? '—';
    final devices = ref.watch(knownDevicesProvider).length;
    final version = info == null
        ? '…'
        : '${info.version} (${info.buildNumber})';

    return Scaffold(
      appBar: AppBar(title: const Text('About')),
      body: ListView(
        padding: const EdgeInsets.symmetric(vertical: Spacing.sm),
        children: [
          const SizedBox(height: Spacing.md),
          Center(
            child: ClipRRect(
              borderRadius: BorderRadius.circular(22),
              child: Image.asset(
                'assets/branding/logo.png',
                width: 84,
                height: 84,
              ),
            ),
          ),
          const SizedBox(height: Spacing.sm),
          Center(
            child: Text(
              'Smart Control',
              style: theme.textTheme.titleLarge?.copyWith(
                fontWeight: FontWeight.w800,
              ),
            ),
          ),
          Center(
            child: Text(
              'Version $version',
              style: theme.textTheme.bodyMedium?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ),
          const SizedBox(height: Spacing.lg),
          Card(
            child: Column(
              children: [
                ListTile(
                  leading: const Icon(Icons.dns_outlined),
                  title: const Text('Server'),
                  subtitle: Text(server),
                  trailing: IconButton(
                    tooltip: 'Copy',
                    icon: const Icon(Icons.copy_rounded),
                    onPressed: () async {
                      await Clipboard.setData(ClipboardData(text: server));
                      if (context.mounted) {
                        ScaffoldMessenger.of(context).showSnackBar(
                          const SnackBar(
                            content: Text('Server address copied'),
                          ),
                        );
                      }
                    },
                  ),
                ),
                const Divider(height: 1),
                ListTile(
                  leading: const Icon(Icons.developer_board_outlined),
                  title: const Text('Devices on this phone'),
                  trailing: Text(
                    '$devices',
                    style: theme.textTheme.titleMedium,
                  ),
                ),
                if (info != null) ...[
                  const Divider(height: 1),
                  ListTile(
                    leading: const Icon(Icons.android_rounded),
                    title: const Text('Package'),
                    subtitle: Text(info.packageName),
                  ),
                ],
              ],
            ),
          ),
          Card(
            child: ListTile(
              leading: const Icon(Icons.description_outlined),
              title: const Text('Open-source licenses'),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => showLicensePage(
                context: context,
                applicationName: 'Smart Control',
                applicationVersion: info?.version,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
