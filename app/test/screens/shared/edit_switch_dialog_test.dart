import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:smart_switch/models/device/switch_config.dart';
import 'package:smart_switch/screens/shared/edit_switch_dialog.dart';

void main() {
  const initial = SwitchConfig(
    channelIdx: 1,
    name: 'Pump',
    zone: 'Garden',
    type: SwitchType.onOff,
    defaultBootState: BootState.off,
    maxOnSeconds: 90, // sub-minute precision, e.g. set from the dashboard
    minOffSeconds: 3 * 3600 + 5 * 60,
  );

  Future<SwitchConfig?> runDialog(
    WidgetTester tester,
    Future<void> Function() edit,
  ) async {
    SwitchConfig? result;
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => TextButton(
            onPressed: () async =>
                result = await showEditSwitchDialog(context, initial),
            child: const Text('open'),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await edit();
    await tester.ensureVisible(find.text('Save'));
    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();
    return result;
  }

  testWidgets('untouched safety fields keep their exact values', (
    tester,
  ) async {
    final result = await runDialog(tester, () async {
      await tester.enterText(find.widgetWithText(TextFormField, 'Pump'), 'Well');
    });
    expect(result, isNotNull);
    expect(result!.name, 'Well');
    expect(result.maxOnSeconds, 90);
    expect(result.minOffSeconds, 3 * 3600 + 5 * 60);
    expect(result.locked, isFalse);
    expect(result.watts, isNull);
  });

  testWidgets('clearing min off time, setting watts and locking', (
    tester,
  ) async {
    final result = await runDialog(tester, () async {
      // Min off time shows "3" h and "5" min (max run time shows "2" min).
      await tester.enterText(find.widgetWithText(TextFormField, '3'), '');
      await tester.enterText(find.widgetWithText(TextFormField, '5'), '');
      await tester.enterText(
        find.widgetWithText(TextFormField, 'Power (watts)'),
        '750',
      );
      await tester.ensureVisible(find.text('Lock switch'));
      await tester.tap(find.text('Lock switch'));
      await tester.pump();
    });
    expect(result, isNotNull);
    expect(result!.minOffSeconds, isNull);
    expect(result.watts, 750);
    expect(result.locked, isTrue);
    expect(result.maxOnSeconds, 90);
    expect(result.toJson()['min_off_s'], isNull);
    expect(result.toJson().containsKey('min_off_s'), isTrue);
  });
}
