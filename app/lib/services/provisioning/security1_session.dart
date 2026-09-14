import 'dart:convert';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart' as crypto;
import 'package:pointycastle/api.dart' as pc;
import 'package:pointycastle/block/aes.dart';
import 'package:pointycastle/stream/ctr.dart';

import 'proto_wire.dart';

// Sec1MsgType (protocomm/proto/sec1.proto)
const _msgSessionCommand0 = 0;
const _msgSessionCommand1 = 2;

// SecSchemeVersion (protocomm/proto/session.proto)
const _secScheme1 = 1;

/// Ported byte-for-byte from ESP-IDF's own reference implementation
/// (`esp_prov/security/security1.py`) — implements protocomm's
/// "Security1" session: an X25519 ECDH handshake mixed with a
/// Proof-of-Possession (POP) string, producing a single AES-256-CTR
/// keystream that both sides then reuse for every later request/response
/// in the session. CTR-mode "encrypt" and "decrypt" are literally the
/// same XOR-with-keystream operation, so this class exposes just one
/// [encrypt]/[decrypt] pair (aliases of the same call) — call order must
/// match the wire protocol's request/response order exactly, since the
/// keystream continuously advances with every call.
class Security1Session {
  Security1Session({required String pop}) : _pop = pop;

  final String _pop;
  late crypto.SimpleKeyPair _keyPair;
  late Uint8List _clientPublicKey;
  late Uint8List _devicePublicKey;
  pc.StreamCipher? _cipher;

  /// Builds the first `prov-session` request body (`SessionData` wrapping
  /// a fresh X25519 client public key).
  Future<Uint8List> buildHandshakeRequest0() async {
    _keyPair = await crypto.X25519().newKeyPair();
    final publicKey = await _keyPair.extractPublicKey();
    _clientPublicKey = Uint8List.fromList(publicKey.bytes);

    final sc0 = ProtoWriter()..writeBytes(1, _clientPublicKey);
    final sec1 = ProtoWriter()
      ..writeVarint(1, _msgSessionCommand0)
      ..writeMessage(20, sc0.toBytes());
    return (ProtoWriter()
          ..writeVarint(2, _secScheme1)
          ..writeMessage(11, sec1.toBytes()))
        .toBytes();
  }

  /// Consumes the device's response to request 0 (`SessionResp0`):
  /// derives the shared secret (X25519 ECDH XORed with `SHA256(POP)`,
  /// unless POP is empty) and initializes the AES-256-CTR keystream keyed
  /// by it, using the device's random nonce as the initial 128-bit
  /// counter block.
  Future<void> consumeHandshakeResponse0(Uint8List body) async {
    final sr0 = _unwrapSec1(body, expectedField: 21, what: 'SessionResp0');
    final devicePublicKey = sr0[2]?.bytesValue;
    final deviceRandom = sr0[3]?.bytesValue;
    if (devicePublicKey == null || deviceRandom == null) {
      throw const FormatException('incomplete SessionResp0');
    }
    _devicePublicKey = devicePublicKey;

    final sharedSecretKey = await crypto.X25519().sharedSecretKey(
      keyPair: _keyPair,
      remotePublicKey: crypto.SimplePublicKey(
        devicePublicKey,
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
        pc.ParametersWithIV(pc.KeyParameter(sharedSecret), deviceRandom),
      );
  }

  /// Builds the second `prov-session` request body (`SessionCmd1`,
  /// carrying the device's own public key encrypted through the
  /// now-established keystream, proving this client holds the same POP).
  Uint8List buildHandshakeRequest1() {
    final clientVerifyData = _cipher!.process(_devicePublicKey);

    final sc1 = ProtoWriter()..writeBytes(2, clientVerifyData);
    final sec1 = ProtoWriter()
      ..writeVarint(1, _msgSessionCommand1)
      ..writeMessage(22, sc1.toBytes());
    return (ProtoWriter()
          ..writeVarint(2, _secScheme1)
          ..writeMessage(11, sec1.toBytes()))
        .toBytes();
  }

  /// Consumes the device's response to request 1 (`SessionResp1`) and
  /// confirms both sides derived the same key: the device's
  /// `device_verify_data`, decrypted, must equal our own client public
  /// key. Returns whether verification succeeded — the handshake is
  /// complete (and [encrypt]/[decrypt] become usable) only if this
  /// returns `true`.
  bool consumeHandshakeResponse1(Uint8List body) {
    final sr1 = _unwrapSec1(body, expectedField: 23, what: 'SessionResp1');
    final deviceVerifyData = sr1[3]?.bytesValue;
    if (deviceVerifyData == null) {
      return false;
    }
    final decrypted = _cipher!.process(deviceVerifyData);
    if (decrypted.length != _clientPublicKey.length) {
      return false;
    }
    for (var i = 0; i < decrypted.length; i++) {
      if (decrypted[i] != _clientPublicKey[i]) {
        return false;
      }
    }
    return true;
  }

  /// Both directions are the identical AES-CTR keystream XOR — kept as
  /// two names purely for call-site clarity.
  Uint8List encrypt(Uint8List plaintext) => _cipher!.process(plaintext);
  Uint8List decrypt(Uint8List ciphertext) => _cipher!.process(ciphertext);

  Map<int, ProtoField> _unwrapSec1(
    Uint8List sessionDataBody, {
    required int expectedField,
    required String what,
  }) {
    final session = decodeMessage(sessionDataBody);
    final sec1Bytes = session[11]?.bytesValue;
    if (sec1Bytes == null) {
      throw FormatException('missing sec1 payload while expecting $what');
    }
    final sec1 = decodeMessage(sec1Bytes);
    final inner = sec1[expectedField]?.bytesValue;
    if (inner == null) {
      throw FormatException('missing $what in Sec1Payload');
    }
    return decodeMessage(inner);
  }
}
