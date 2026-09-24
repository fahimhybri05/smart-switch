import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:smart_switch/providers/service_providers.dart';
import 'package:smart_switch/screens/account/account_screen.dart';
import 'package:smart_switch/services/backend/backend_auth_client.dart';

class _FakeAuth extends AuthNotifier {
  @override
  AuthState build() =>
      (email: 'fahim@example.com', accessToken: 'a', refreshToken: 'r');

  @override
  Future<AccountInfo> fetchAccount() async => (
    email: 'fahim@example.com',
    createdAt: DateTime(2026, 3, 1),
    households: const [(name: 'Home', role: 'owner')],
  );
}

Widget _app(Widget child) => ProviderScope(
  overrides: [authProvider.overrideWith(_FakeAuth.new)],
  child: MaterialApp(home: child),
);

void main() {
  testWidgets('account screen shows profile, sign-in options and delete', (
    tester,
  ) async {
    await tester.pumpWidget(_app(const AccountScreen()));
    await tester.pumpAndSettle();
    expect(find.text('fahim@example.com'), findsWidgets);
    expect(find.textContaining('1 household'), findsOneWidget);
    expect(find.text('Home · owner'), findsOneWidget);
    expect(find.text('Password'), findsOneWidget);
    expect(find.text('Delete account'), findsOneWidget);

    await tester.tap(find.text('Password'));
    await tester.pumpAndSettle();
    expect(find.text('Confirm new password'), findsOneWidget);
    // Mismatched confirmation is caught before any request.
    await tester.enterText(
      find.widgetWithText(TextFormField, 'Current password'),
      'old-password',
    );
    await tester.enterText(
      find.widgetWithText(TextFormField, 'New password'),
      'new-password',
    );
    await tester.enterText(
      find.widgetWithText(TextFormField, 'Confirm new password'),
      'different',
    );
    await tester.tap(find.widgetWithText(FilledButton, 'Change password'));
    await tester.pumpAndSettle();
    expect(find.text('Passwords don’t match'), findsOneWidget);
  });

  testWidgets('delete button stays disabled until acknowledged', (
    tester,
  ) async {
    await tester.pumpWidget(_app(const DeleteAccountScreen()));
    await tester.pumpAndSettle();
    final button = find.widgetWithText(FilledButton, 'Delete my account');
    expect(tester.widget<FilledButton>(button).onPressed, isNull);
    await tester.tap(find.byType(Checkbox));
    await tester.pump();
    expect(tester.widget<FilledButton>(button).onPressed, isNotNull);
  });
}
