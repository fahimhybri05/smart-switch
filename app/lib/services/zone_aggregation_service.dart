import '../models/device/device_config.dart';
import '../models/device/switch_config.dart';

/// One switch's identity within a [Zone] — which device it lives on plus
/// its config, so a toggle can be routed back to the right DeviceApiClient.
class ZoneSwitchRef {
  const ZoneSwitchRef({required this.deviceId, required this.switchConfig});

  final String deviceId;
  final SwitchConfig switchConfig;
}

/// A zone has no device-resident entity (spec §7) — it's purely the app
/// grouping every known device's switches by their `zone` string tag.
class Zone {
  const Zone({required this.name, required this.switches});

  final String name;
  final List<ZoneSwitchRef> switches;
}

const _unassignedZoneName = 'Unassigned';

/// Builds Zones screen's data by grouping switches across all currently
/// known devices, live, in memory — no zone entity is persisted anywhere.
class ZoneAggregationService {
  List<Zone> buildZones(List<DeviceConfig> devices) {
    final byZone = <String, List<ZoneSwitchRef>>{};

    for (final device in devices) {
      for (final sw in device.switches) {
        final zoneName = sw.zone.trim().isEmpty
            ? _unassignedZoneName
            : sw.zone.trim();
        byZone
            .putIfAbsent(zoneName, () => [])
            .add(ZoneSwitchRef(deviceId: device.deviceId, switchConfig: sw));
      }
    }

    final zones = byZone.entries
        .map((e) => Zone(name: e.key, switches: e.value))
        .toList();
    zones.sort((a, b) {
      if (a.name == _unassignedZoneName) return 1;
      if (b.name == _unassignedZoneName) return -1;
      return a.name.compareTo(b.name);
    });
    return zones;
  }
}
