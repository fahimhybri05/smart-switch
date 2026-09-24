import 'package:flutter_test/flutter_test.dart';
import 'package:smart_switch/services/app_shortcuts.dart';

void main() {
  test('parses toggle shortcuts, including device ids containing colons', () {
    expect(parseShortcut('toggle:esp8266-6ea10f:3'), (
      deviceId: 'esp8266-6ea10f',
      channelIdx: 3,
    ));
    expect(parseShortcut('toggle:a:b:0'), (deviceId: 'a:b', channelIdx: 0));
  });

  test('rejects anything else', () {
    expect(parseShortcut('open:settings'), isNull);
    expect(parseShortcut('toggle:'), isNull);
    expect(parseShortcut('toggle:dev:x'), isNull);
  });
}
