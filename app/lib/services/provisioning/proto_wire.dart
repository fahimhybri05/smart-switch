import 'dart:typed_data';

/// Minimal hand-rolled protobuf wire encode/decode — no `protoc`/codegen
/// dependency (none is available in this build environment). Scoped
/// exactly to what ESP-IDF's protocomm/wifi_provisioning `.proto` schemas
/// actually use for our flow: wire type 0 (varint, for int32/enum fields)
/// and wire type 2 (length-delimited, for bytes/string/nested-message
/// fields) — no repeated fields, no maps, no fixed32/64. `oneof` needs no
/// special handling on the wire: it's a language-level constraint only,
/// so encoding "whichever field is set" is already correct.
class ProtoWriter {
  final BytesBuilder _out = BytesBuilder();

  void writeVarint(int fieldNumber, int value) {
    _writeTag(fieldNumber, 0);
    _writeRawVarint(value);
  }

  void writeBytes(int fieldNumber, List<int> value) {
    _writeTag(fieldNumber, 2);
    _writeRawVarint(value.length);
    _out.add(value);
  }

  /// A nested message is just length-delimited bytes on the wire —
  /// identical encoding to [writeBytes], kept as a separate name for
  /// readability at call sites.
  void writeMessage(int fieldNumber, List<int> encodedMessage) =>
      writeBytes(fieldNumber, encodedMessage);

  void _writeTag(int fieldNumber, int wireType) =>
      _writeRawVarint((fieldNumber << 3) | wireType);

  void _writeRawVarint(int value) {
    var v = value;
    while (true) {
      if (v & ~0x7F == 0) {
        _out.addByte(v);
        return;
      }
      _out.addByte((v & 0x7F) | 0x80);
      v >>= 7;
    }
  }

  Uint8List toBytes() => _out.toBytes();
}

class ProtoField {
  const ProtoField._({this.varintValue, this.bytesValue});

  final int? varintValue;
  final Uint8List? bytesValue;
}

/// Decodes a flat top-level view of a message: field number → last-seen
/// value (protobuf semantics: a later occurrence of the same field number
/// overrides an earlier one, which is also exactly what a `oneof` looks
/// like on the wire when only one variant is actually present).
Map<int, ProtoField> decodeMessage(Uint8List data) {
  final fields = <int, ProtoField>{};
  var pos = 0;

  int readRawVarint() {
    var result = 0;
    var shift = 0;
    while (true) {
      final b = data[pos++];
      result |= (b & 0x7F) << shift;
      if (b & 0x80 == 0) return result;
      shift += 7;
    }
  }

  while (pos < data.length) {
    final tag = readRawVarint();
    final fieldNumber = tag >> 3;
    final wireType = tag & 0x7;
    switch (wireType) {
      case 0:
        fields[fieldNumber] = ProtoField._(varintValue: readRawVarint());
      case 2:
        final len = readRawVarint();
        fields[fieldNumber] = ProtoField._(
          bytesValue: Uint8List.sublistView(data, pos, pos + len),
        );
        pos += len;
      default:
        throw FormatException(
          'Unsupported protobuf wire type $wireType for field $fieldNumber',
        );
    }
  }
  return fields;
}
