import 'dart:convert';

import '../models/local/known_device.dart';
import '../models/local/switch_group.dart';

typedef ImportedBackup = ({
  List<KnownDevice> devices,
  List<SwitchGroup> groups,
});

/// Builds/parses the local backup file format: `known_devices` + `groups`
/// (the only two things actually persisted on the phone — see
/// device_registry_service.dart / group_service.dart) plus a best-effort,
/// diagnostic-only snapshot of each device's live switches/schedules.
///
/// `device_snapshots` is intentionally never re-applied on import — a device
/// already holds its own real config; silently pushing a stale snapshot back
/// over HTTP on restore could overwrite it unexpectedly. Import only
/// restores local pairing data (known_devices + groups).
class BackupService {
  static const _formatVersion = 1;

  String buildExportJson({
    required List<KnownDevice> devices,
    required List<SwitchGroup> groups,
    required Map<String, Map<String, dynamic>?> deviceSnapshots,
  }) {
    return jsonEncode({
      'format_version': _formatVersion,
      'exported_at': DateTime.now().toIso8601String(),
      'known_devices': devices.map((d) => d.toJson()).toList(),
      'groups': groups.map((g) => g.toJson()).toList(),
      'device_snapshots': deviceSnapshots,
    });
  }

  /// Throws [FormatException] on invalid/unparseable input.
  ImportedBackup parseImportJson(String raw) {
    final decoded = jsonDecode(raw);
    if (decoded is! Map<String, dynamic>) {
      throw const FormatException('not a backup file');
    }

    final devicesJson = decoded['known_devices'];
    final groupsJson = decoded['groups'];
    if (devicesJson is! List || groupsJson is! List) {
      throw const FormatException('missing known_devices/groups');
    }

    return (
      devices: devicesJson
          .map((e) => KnownDevice.fromJson(e as Map<String, dynamic>))
          .toList(),
      groups: groupsJson
          .map((e) => SwitchGroup.fromJson(e as Map<String, dynamic>))
          .toList(),
    );
  }
}
