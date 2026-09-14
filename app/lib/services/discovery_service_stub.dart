import 'discovery_service.dart';

/// Web fallback — multicast_dns needs raw dart:io sockets, unavailable in a
/// browser. Returns an empty stream rather than fake data; the app remains
/// fully usable via manually-entered/known devices on web, discovery just
/// finds nothing.
class _StubDiscoveryService implements DiscoveryService {
  @override
  Stream<DiscoveredDevice> startDiscovery() => const Stream.empty();

  @override
  Future<void> stopDiscovery() async {}
}

DiscoveryService createDiscoveryService() => _StubDiscoveryService();
