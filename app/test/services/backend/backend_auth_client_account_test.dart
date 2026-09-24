import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:smart_switch/services/backend/backend_api_exception.dart';
import 'package:smart_switch/services/backend/backend_auth_client.dart';

void main() {
  final client = BackendAuthClient(baseUrl: 'https://api.example.test');
  late http.Request last;

  Future<T> withBackend<T>(
    http.Response Function(http.Request) respond,
    Future<T> Function() body,
  ) => http.runWithClient(
    body,
    () => MockClient((req) async {
      last = req;
      return respond(req);
    }),
  );

  test('me parses email, createdAt and households', () async {
    final info = await withBackend(
      (_) => http.Response(
        jsonEncode({
          'id': 1,
          'email': 'a@b.co',
          'createdAt': '2026-01-02T03:04:05Z',
          'households': [
            {'id': 7, 'name': 'Home', 'role': 'owner'},
          ],
        }),
        200,
      ),
      () => client.me('tok'),
    );
    expect(last.method, 'GET');
    expect(last.url.path, '/auth/me');
    expect(last.headers['Authorization'], 'Bearer tok');
    expect(info.email, 'a@b.co');
    expect(info.createdAt, DateTime.utc(2026, 1, 2, 3, 4, 5));
    expect(info.households.single.role, 'owner');
  });

  test(
    'changePassword sends both passwords and returns the new pair',
    () async {
      final tokens = await withBackend(
        (_) => http.Response(
          jsonEncode({'accessToken': 'A2', 'refreshToken': 'R2'}),
          200,
        ),
        () => client.changePassword(
          'tok',
          currentPassword: 'old-pass',
          newPassword: 'new-pass-1',
        ),
      );
      expect(last.method, 'PATCH');
      expect(last.url.path, '/auth/password');
      expect(jsonDecode(last.body), {
        'currentPassword': 'old-pass',
        'newPassword': 'new-pass-1',
      });
      expect(tokens.accessToken, 'A2');
      expect(tokens.refreshToken, 'R2');
    },
  );

  test('changeEmail returns the normalized email from the backend', () async {
    final email = await withBackend(
      (_) => http.Response(jsonEncode({'id': 1, 'email': 'new@b.co'}), 200),
      () => client.changeEmail('tok', newEmail: 'New@B.co', password: 'pw'),
    );
    expect(last.url.path, '/auth/email');
    expect(jsonDecode(last.body), {'newEmail': 'New@B.co', 'password': 'pw'});
    expect(email, 'new@b.co');
  });

  test(
    'deleteAccount sends DELETE with the password and accepts 204',
    () async {
      await withBackend(
        (_) => http.Response('', 204),
        () => client.deleteAccount('tok', password: 'pw'),
      );
      expect(last.method, 'DELETE');
      expect(last.url.path, '/auth/account');
      expect(jsonDecode(last.body), {'password': 'pw'});
    },
  );

  test('wrong password surfaces as a 403 BackendApiException', () async {
    await expectLater(
      withBackend(
        (_) => http.Response(jsonEncode({'error': 'incorrect password'}), 403),
        () => client.deleteAccount('tok', password: 'nope'),
      ),
      throwsA(
        isA<BackendApiException>().having(
          (e) => e.statusCode,
          'statusCode',
          403,
        ),
      ),
    );
  });
}
