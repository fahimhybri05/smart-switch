import 'package:flutter_test/flutter_test.dart';
import 'package:smart_switch/models/device/channel_state.dart';
import 'package:smart_switch/screens/shared/friendly_error.dart';
import 'package:smart_switch/services/api_error_body.dart';
import 'package:smart_switch/services/backend/backend_api_exception.dart';
import 'package:smart_switch/services/backend/backend_ws_client.dart';
import 'package:smart_switch/services/device_api_client.dart';
import 'package:smart_switch/services/device_transport.dart';

class _FakeTransport implements DeviceTransport {
  _FakeTransport(this.response);

  final DeviceTransportResponse response;

  @override
  Future<DeviceTransportResponse> send(
    String method,
    String path, {
    Object? body,
    bool allowFallbackAfterTimeout = true,
  }) async => response;
}

void main() {
  group('friendlyErrorMessage — lock / min-off', () {
    test('REST 423 switch_locked (DeviceApiException)', () {
      expect(
        friendlyErrorMessage(DeviceApiException(423, 'switch_locked'), 'Toggle'),
        'This switch is locked.',
      );
    });

    test('WS relay switch_locked (CloudRelayException)', () {
      expect(
        friendlyErrorMessage(CloudRelayException('switch_locked'), 'Toggle'),
        'This switch is locked.',
      );
    });

    test('min_off_time rounds retryAfterSeconds up to minutes', () {
      expect(
        friendlyErrorMessage(
          DeviceApiException(409, 'min_off_time', retryAfterSeconds: 125),
          'Toggle',
        ),
        'Protection: wait 3 min before turning it on again.',
      );
      expect(
        friendlyErrorMessage(
          CloudRelayException('min_off_time', retryAfterSeconds: 30),
          'Toggle',
        ),
        'Protection: wait 1 min before turning it on again.',
      );
      expect(
        friendlyErrorMessage(
          BackendApiException(409, 'min_off_time', retryAfterSeconds: 600),
          'Toggle',
        ),
        'Protection: wait 10 min before turning it on again.',
      );
    });

    test('min_off_time without a retry hint still reads sensibly', () {
      expect(
        friendlyCommandError('min_off_time', null),
        'Protection: wait a moment before turning it on again.',
      );
    });

    test('unrelated errors keep the old fallbacks', () {
      expect(
        friendlyErrorMessage(DeviceApiException(401, 'unauthorized'), 'Toggle'),
        'Your session expired — please sign in again.',
      );
      expect(
        friendlyErrorMessage(DeviceApiException(500, 'boom'), 'Toggle'),
        'Toggle failed. Please try again.',
      );
      expect(friendlyCommandError('device_offline', null), isNull);
    });
  });

  group('ApiErrorBody', () {
    test('flat shape', () {
      final e = ApiErrorBody.parse({
        'error': 'min_off_time',
        'retryAfterSeconds': 42,
      });
      expect(e.code, CommandErrorCodes.minOffTime);
      expect(e.retryAfterSeconds, 42);
    });

    test('nested /v1 shape', () {
      final e = ApiErrorBody.parse({
        'error': {
          'code': 'min_off_time',
          'message': 'wait',
          'retryAfterSeconds': 7.2,
        },
      });
      expect(e.code, 'min_off_time');
      expect(e.retryAfterSeconds, 8);
    });

    test('non-map bodies', () {
      expect(ApiErrorBody.parse(null).code, isNull);
      expect(ApiErrorBody.parse([1, 2]).code, isNull);
    });
  });

  test('DeviceApiClient carries the 409 body through to the exception', () async {
    final client = DeviceApiClient.withTransport(
      _FakeTransport(
        const DeviceTransportResponse(
          statusCode: 409,
          body: {'error': 'min_off_time', 'retryAfterSeconds': 240},
        ),
      ),
    );
    await expectLater(
      client.setChannelState(0, ChannelPowerState.on),
      throwsA(
        isA<DeviceApiException>()
            .having((e) => e.statusCode, 'statusCode', 409)
            .having((e) => e.message, 'message', 'min_off_time')
            .having((e) => e.retryAfterSeconds, 'retryAfterSeconds', 240),
      ),
    );
  });
}
