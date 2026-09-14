import 'package:flutter/services.dart';
import 'package:multicast_dns/multicast_dns.dart';

import 'discovery_service.dart';

const _serviceType = '_esp-switch._tcp.local';

// Android silently drops incoming multicast packets unless the app holds a
// WifiManager.MulticastLock — multicast_dns doesn't acquire this itself.
// No-op (throws are swallowed) on platforms without this channel (iOS/web).
const _multicastLockChannel = MethodChannel(
  'tech.hybri.smart_switch/multicast_lock',
);

Future<void> _acquireMulticastLock() async {
  try {
    await _multicastLockChannel.invokeMethod('acquire');
  } catch (_) {}
}

Future<void> _releaseMulticastLock() async {
  try {
    await _multicastLockChannel.invokeMethod('release');
  } catch (_) {}
}

class _MdnsDiscoveryService implements DiscoveryService {
  MDnsClient? _client;

  @override
  Stream<DiscoveredDevice> startDiscovery() async* {
    await _acquireMulticastLock();
    final client = MDnsClient();
    _client = client;
    await client.start();

    try {
      await for (final PtrResourceRecord ptr
          in client.lookup<PtrResourceRecord>(
            ResourceRecordQuery.serverPointer(_serviceType),
          )) {
        String? target;
        int? port;
        await for (final SrvResourceRecord srv
            in client.lookup<SrvResourceRecord>(
              ResourceRecordQuery.service(ptr.domainName),
            )) {
          target = srv.target;
          port = srv.port;
          break;
        }
        if (target == null || port == null) {
          continue;
        }

        final txt = <String, String>{};
        await for (final TxtResourceRecord txtRecord
            in client.lookup<TxtResourceRecord>(
              ResourceRecordQuery.text(ptr.domainName),
            )) {
          // Each mDNS TXT string is "key=value"; the package joins multiple
          // strings with '\n' (confirmed in its packet decoder).
          for (final line in txtRecord.text.split('\n')) {
            if (line.isEmpty) {
              continue;
            }
            final eq = line.indexOf('=');
            if (eq <= 0) {
              continue;
            }
            txt[line.substring(0, eq)] = line.substring(eq + 1);
          }
          break;
        }

        String? host;
        await for (final IPAddressResourceRecord ip
            in client.lookup<IPAddressResourceRecord>(
              ResourceRecordQuery.addressIPv4(target),
            )) {
          host = ip.address.address;
          break;
        }
        if (host == null) {
          continue;
        }

        yield DiscoveredDevice(
          deviceId: txt['device_id'] ?? ptr.domainName,
          host: host,
          port: port,
          txt: txt,
        );
      }
    } finally {
      client.stop();
      await _releaseMulticastLock();
    }
  }

  @override
  Future<void> stopDiscovery() async {
    _client?.stop();
    _client = null;
    await _releaseMulticastLock();
  }
}

DiscoveryService createDiscoveryService() => _MdnsDiscoveryService();
