/** OpenAPI 3.0 description of the public API, served at GET /v1/openapi.json. */

const errorResponse = (description) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
});

const switchResponse = {
  description: 'The switch (after the action, for actuation endpoints).',
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Switch' } } },
};

const switchIdParam = {
  name: 'id',
  in: 'path',
  required: true,
  description: 'Switch id, "<deviceId>:<channel>" (e.g. esp8266-3d87ce:0). URL-encode the colon if your client requires it.',
  schema: { type: 'string' },
};

const actuationErrors = {
  401: errorResponse('Missing, invalid or revoked API key.'),
  404: errorResponse('Switch not found (or not in any of your households).'),
  409: errorResponse('min_off_time: the switch must stay off longer before turning on (see error.retryAfterSeconds).'),
  423: errorResponse('switch_locked: the switch is locked.'),
  429: errorResponse('Rate limited.'),
  502: errorResponse('device_error: the device rejected the command.'),
  503: errorResponse('device_offline: the device is not connected.'),
  504: errorResponse('device_timeout: the device did not answer in time.'),
};

function actionOperation(action, summary) {
  return {
    post: {
      summary,
      operationId: `${action}Switch`,
      parameters: [switchIdParam],
      responses: { 200: switchResponse, ...actuationErrors },
    },
  };
}

function hookOperation(action, summary) {
  const op = {
    summary,
    security: [],
    parameters: [
      { name: 'token', in: 'path', required: true, schema: { type: 'string', pattern: '^wh_' } },
      {
        name: 'format',
        in: 'query',
        required: false,
        description: '"text" returns the resulting state as plain text (on/off/unknown).',
        schema: { type: 'string', enum: ['text'] },
      },
    ],
    responses: {
      200: switchResponse,
      404: errorResponse('Any failure: unknown/revoked hook or key, or no longer allowed.'),
      409: errorResponse('min_off_time (see error.retryAfterSeconds)'),
      423: errorResponse('switch_locked'),
      429: errorResponse('Rate limited.'),
      503: errorResponse('device_offline'),
      504: errorResponse('device_timeout'),
    },
  };
  return { get: { ...op, operationId: `hook${action}Get` }, post: { ...op, operationId: `hook${action}Post` } };
}

export function buildOpenApiSpec(serverUrl) {
  return {
    openapi: '3.0.3',
    info: {
      title: 'Smart Control API',
      version: '1.0.0',
      description:
        'Control your Smart Control switches. Authenticate with an API key: `Authorization: Bearer sk_...` ' +
        '(create one in the web dashboard). Every error has the shape `{"error":{"code","message"}}`. ' +
        'Limits: 120 requests/minute per key; 30 failed authentications per 15 minutes per IP.',
    },
    servers: [{ url: serverUrl }],
    security: [{ apiKey: [] }],
    components: {
      securitySchemes: {
        apiKey: { type: 'http', scheme: 'bearer', description: 'API key (sk_...)' },
      },
      schemas: {
        Error: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message'],
              properties: {
                code: {
                  type: 'string',
                  example: 'device_offline',
                  description:
                    'missing_api_key | invalid_api_key | invalid_request | invalid_json | not_found | ' +
                    'method_not_allowed | rate_limited | device_offline | device_timeout | device_error | ' +
                    'switch_locked | min_off_time | internal_error',
                },
                message: { type: 'string' },
                retryAfterSeconds: {
                  type: 'integer',
                  description: 'min_off_time only: seconds until the switch may be turned on.',
                },
              },
            },
          },
        },
        Switch: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'esp8266-3d87ce:0' },
            deviceId: { type: 'string', example: 'esp8266-3d87ce' },
            deviceName: { type: 'string', example: 'Living room' },
            channel: { type: 'integer', example: 0 },
            name: { type: 'string', example: 'Ceiling light' },
            zone: { type: 'string', example: 'Living room' },
            state: { type: 'string', enum: ['on', 'off', 'unknown'] },
            online: { type: 'boolean' },
            updatedAt: { type: 'string', format: 'date-time', nullable: true },
          },
        },
        Device: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'esp8266-3d87ce' },
            name: { type: 'string' },
            householdId: { type: 'integer' },
            online: { type: 'boolean' },
            lastSeenAt: { type: 'string', format: 'date-time', nullable: true },
            switchCount: { type: 'integer', example: 6 },
          },
        },
      },
    },
    paths: {
      '/v1/me': {
        get: {
          summary: 'The account and key making the request',
          operationId: 'getMe',
          responses: {
            200: {
              description: 'Account info',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      id: { type: 'integer' },
                      email: { type: 'string' },
                      households: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            id: { type: 'integer' },
                            name: { type: 'string' },
                            role: { type: 'string', enum: ['owner', 'member'] },
                          },
                        },
                      },
                      apiKey: {
                        type: 'object',
                        properties: { id: { type: 'integer' }, name: { type: 'string' }, prefix: { type: 'string' } },
                      },
                    },
                  },
                },
              },
            },
            401: errorResponse('Missing, invalid or revoked API key.'),
          },
        },
      },
      '/v1/devices': {
        get: {
          summary: 'List devices',
          operationId: 'listDevices',
          responses: {
            200: {
              description: 'Devices in all your households',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { devices: { type: 'array', items: { $ref: '#/components/schemas/Device' } } },
                  },
                },
              },
            },
            401: errorResponse('Missing, invalid or revoked API key.'),
          },
        },
      },
      '/v1/switches': {
        get: {
          summary: 'List switches',
          operationId: 'listSwitches',
          parameters: [{ name: 'deviceId', in: 'query', required: false, schema: { type: 'string' } }],
          responses: {
            200: {
              description: 'Switches',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { switches: { type: 'array', items: { $ref: '#/components/schemas/Switch' } } },
                  },
                },
              },
            },
            401: errorResponse('Missing, invalid or revoked API key.'),
            404: errorResponse('deviceId given but not found.'),
          },
        },
      },
      '/v1/switches/{id}': {
        get: {
          summary: 'Get one switch',
          operationId: 'getSwitch',
          parameters: [switchIdParam],
          responses: {
            200: switchResponse,
            401: errorResponse('Missing, invalid or revoked API key.'),
            404: errorResponse('Switch not found.'),
          },
        },
        patch: {
          summary: 'Set a switch state',
          operationId: 'setSwitch',
          parameters: [switchIdParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['state'],
                  properties: { state: { type: 'string', enum: ['on', 'off'] } },
                },
              },
            },
          },
          responses: {
            200: switchResponse,
            400: errorResponse('invalid_request / invalid_json'),
            ...actuationErrors,
          },
        },
      },
      '/v1/switches/{id}/on': actionOperation('on', 'Turn a switch on'),
      '/v1/switches/{id}/off': actionOperation('off', 'Turn a switch off'),
      '/v1/switches/{id}/toggle': actionOperation('toggle', 'Toggle a switch (unknown state turns it on)'),
      '/v1/hook/{token}/on': hookOperation('On', 'Hook URL: turn on (no auth header)'),
      '/v1/hook/{token}/off': hookOperation('Off', 'Hook URL: turn off (no auth header)'),
      '/v1/hook/{token}/toggle': hookOperation('Toggle', 'Hook URL: toggle (no auth header)'),
      '/v1/hook/{token}/status': hookOperation('Status', 'Hook URL: current state (no auth header)'),
    },
  };
}
