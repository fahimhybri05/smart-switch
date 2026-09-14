import 'discovery_service_stub.dart'
    if (dart.library.io) 'discovery_service_io.dart'
    as impl;

/// One device found while browsing `_esp-switch._tcp.local` (spec §4).
class DiscoveredDevice {
  const DiscoveredDevice({
    required this.deviceId,
    required this.host,
    required this.port,
    required this.txt,
  });

  final String deviceId;
  final String host;
  final int port;
  final Map<String, String> txt;
}

/// mDNS-based LAN discovery of Smart Switch devices. Remote/Tailscale
/// sessions don't reach this path (multicast typically doesn't traverse
/// subnet routes, spec §4/§8) — those rely on DeviceRegistryService's cached
/// lastKnownIp instead.
abstract class DiscoveryService {
  Stream<DiscoveredDevice> startDiscovery();

  Future<void> stopDiscovery();
}

/// Real implementation on Android/iOS (dart:io available); an empty-stream
/// stub on web (multicast_dns needs raw sockets, unavailable there).
DiscoveryService createDiscoveryService() => impl.createDiscoveryService();
