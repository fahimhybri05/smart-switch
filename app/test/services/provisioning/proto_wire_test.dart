import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:smart_switch/services/provisioning/proto_wire.dart';

void main() {
  test('round-trips a varint field', () {
    final bytes = (ProtoWriter()..writeVarint(1, 4)).toBytes();
    final fields = decodeMessage(bytes);
    expect(fields[1]?.varintValue, 4);
  });

  test('round-trips a multi-byte varint (>127)', () {
    final bytes = (ProtoWriter()..writeVarint(2, 300)).toBytes();
    expect(decodeMessage(bytes)[2]?.varintValue, 300);
  });

  test('round-trips a bytes field', () {
    final payload = Uint8List.fromList([1, 2, 3, 4, 5]);
    final bytes = (ProtoWriter()..writeBytes(3, payload)).toBytes();
    expect(decodeMessage(bytes)[3]?.bytesValue, payload);
  });

  test('round-trips a nested message field', () {
    final inner = (ProtoWriter()..writeVarint(1, 42)).toBytes();
    final outer = (ProtoWriter()..writeMessage(11, inner)).toBytes();

    final outerFields = decodeMessage(outer);
    final innerBytes = outerFields[11]?.bytesValue;
    expect(innerBytes, isNotNull);
    expect(decodeMessage(innerBytes!)[1]?.varintValue, 42);
  });

  test('later field occurrence overrides an earlier one (oneof semantics)', () {
    final bytes =
        (ProtoWriter()
              ..writeVarint(1, 1)
              ..writeVarint(1, 2))
            .toBytes();
    expect(decodeMessage(bytes)[1]?.varintValue, 2);
  });

  test(
    'matches the exact wire bytes for a known SessionCmd0-shaped message',
    () {
      // field 1, wire type 2 (length-delimited), 2-byte payload [0xAA, 0xBB]
      // tag = (1 << 3) | 2 = 0x0A
      final bytes = (ProtoWriter()..writeBytes(1, [0xAA, 0xBB])).toBytes();
      expect(bytes, [0x0A, 0x02, 0xAA, 0xBB]);
    },
  );
}
