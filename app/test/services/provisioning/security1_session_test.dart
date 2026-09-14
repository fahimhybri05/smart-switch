import 'dart:convert';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart' as crypto;
import 'package:flutter_test/flutter_test.dart';
import 'package:pointycastle/api.dart' as pc;
import 'package:pointycastle/block/aes.dart';
import 'package:pointycastle/stream/ctr.dart';
import 'package:smart_switch/services/provisioning/proto_wire.dart';
import 'package:smart_switch/services/provisioning/security1_session.dart';

/// A from-scratch, independent mirror of the *device* side of ESP-IDF's
/// Security1 handshake (see docs/plan.md) — deliberately NOT sharing code
/// with [Security1Session] (which only ever plays the client role), so
/// this test catches real protocol/framing bugs rather than "testing a
/// bug against itself".
class _FakeDevice {
  _FakeDevice({required String pop}) : _pop = pop;

  final String _pop;
  late Uint8List _clientPublicKey;
  late Uint8List _devicePublicKey;
  late pc.StreamCipher _cipher;
  final _deviceRandom = Uint8List.fromList(
    List.generate(16, (i) => (i * 7 + 3) % 256),
  );

  /// Handles the client's first `prov-session` request, returns the
  /// device's `SessionResp0`-shaped response bytes.
  Future<Uint8List> handleRequest0(Uint8List req0) async {
    final session = decodeMessage(req0);
    final sec1 = decodeMessage(session[11]!.bytesValue!);
    final sc0 = decodeMessage(sec1[20]!.bytesValue!);
    _clientPublicKey = sc0[1]!.bytesValue!;

    final keyPair = await crypto.X25519().newKeyPair();
    final devicePublic = await keyPair.extractPublicKey();
    _devicePublicKey = Uint8List.fromList(devicePublic.bytes);

    final sharedSecretKey = await crypto.X25519().sharedSecretKey(
      keyPair: keyPair,
      remotePublicKey: crypto.SimplePublicKey(
        _clientPublicKey,
        type: crypto.KeyPairType.x25519,
      ),
    );
    final sharedSecret = Uint8List.fromList(
      await sharedSecretKey.extractBytes(),
    );
    if (_pop.isNotEmpty) {
      final popDigest = Uint8List.fromList(
        (await crypto.Sha256().hash(utf8.encode(_pop))).bytes,
      );
      for (var i = 0; i < sharedSecret.length; i++) {
        sharedSecret[i] ^= popDigest[i];
      }
    }
    _cipher = CTRStreamCipher(AESEngine())
      ..init(
        true,
        pc.ParametersWithIV(pc.KeyParameter(sharedSecret), _deviceRandom),
      );

    final sr0 = ProtoWriter()
      ..writeBytes(2, _devicePublicKey)
      ..writeBytes(3, _deviceRandom);
    final sec1Resp = ProtoWriter()
      ..writeVarint(1, 1) // Session_Response0
      ..writeMessage(21, sr0.toBytes());
    return (ProtoWriter()
          ..writeVarint(2, 1)
          ..writeMessage(11, sec1Resp.toBytes()))
        .toBytes();
  }

  /// Handles the client's second `prov-session` request, returns the
  /// device's `SessionResp1`-shaped response bytes (or throws if the
  /// client's verify data doesn't decrypt to the device's own pubkey —
  /// i.e. a POP mismatch).
  Uint8List handleRequest1(Uint8List req1) {
    final session = decodeMessage(req1);
    final sec1 = decodeMessage(session[11]!.bytesValue!);
    final sc1 = decodeMessage(sec1[22]!.bytesValue!);
    final clientVerifyData = sc1[2]!.bytesValue!;

    final decrypted = _cipher.process(clientVerifyData);
    if (!_bytesEqual(decrypted, _devicePublicKey)) {
      throw StateError('POP mismatch: client verify data did not match');
    }

    final deviceVerifyData = _cipher.process(_clientPublicKey);
    final sr1 = ProtoWriter()..writeBytes(3, deviceVerifyData);
    final sec1Resp = ProtoWriter()
      ..writeVarint(1, 3) // Session_Response1
      ..writeMessage(23, sr1.toBytes());
    return (ProtoWriter()
          ..writeVarint(2, 1)
          ..writeMessage(11, sec1Resp.toBytes()))
        .toBytes();
  }

  Uint8List decrypt(Uint8List ciphertext) => _cipher.process(ciphertext);
  Uint8List encrypt(Uint8List plaintext) => _cipher.process(plaintext);
}

bool _bytesEqual(List<int> a, List<int> b) {
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}

void main() {
  test(
    'client and an independent device mock complete the handshake and agree on a key',
    () async {
      const pop = 'esp-test01';
      final client = Security1Session(pop: pop);
      final device = _FakeDevice(pop: pop);

      final req0 = await client.buildHandshakeRequest0();
      final resp0 = await device.handleRequest0(req0);
      await client.consumeHandshakeResponse0(resp0);

      final req1 = client.buildHandshakeRequest1();
      final resp1 = device.handleRequest1(req1);
      final verified = client.consumeHandshakeResponse1(resp1);

      expect(verified, isTrue);
    },
  );

  test(
    'post-handshake encrypt/decrypt stay in sync between client and device',
    () async {
      const pop = 'esp-test01';
      final client = Security1Session(pop: pop);
      final device = _FakeDevice(pop: pop);

      await client.consumeHandshakeResponse0(
        await device.handleRequest0(await client.buildHandshakeRequest0()),
      );
      expect(
        client.consumeHandshakeResponse1(
          device.handleRequest1(client.buildHandshakeRequest1()),
        ),
        isTrue,
      );

      final plaintext = Uint8List.fromList(utf8.encode('hello device'));
      final ciphertext = client.encrypt(plaintext);
      expect(device.decrypt(ciphertext), plaintext);

      final devicePlaintext = Uint8List.fromList(utf8.encode('hello client'));
      final deviceCiphertext = device.encrypt(devicePlaintext);
      expect(client.decrypt(deviceCiphertext), devicePlaintext);
    },
  );

  test(
    'a POP mismatch fails verification instead of silently succeeding',
    () async {
      final client = Security1Session(pop: 'esp-real-id');
      final device = _FakeDevice(pop: 'esp-different-id');

      await client.consumeHandshakeResponse0(
        await device.handleRequest0(await client.buildHandshakeRequest0()),
      );

      // The device throws on request1 in this fake (would be a rejected
      // response on real firmware) — either way, the client must not treat
      // a mismatch as verified.
      final req1 = client.buildHandshakeRequest1();
      expect(() => device.handleRequest1(req1), throwsStateError);
    },
  );
}
