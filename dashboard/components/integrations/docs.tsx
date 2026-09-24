import { BookOpen, ExternalLink, Gauge, Link2, TriangleAlert } from 'lucide-react';

import { CodeBlock } from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const EXAMPLE_ID = 'esp8266-3d87ce:0';

const ENDPOINTS: { method: string; path: string; desc: string }[] = [
  { method: 'GET', path: '/v1/me', desc: 'The key’s user, households and the key itself' },
  { method: 'GET', path: '/v1/devices', desc: '{ devices: [{ id, name, householdId, online, lastSeenAt, switchCount }] }' },
  { method: 'GET', path: '/v1/switches', desc: '{ switches: [Switch] } — optional ?deviceId=' },
  { method: 'GET', path: '/v1/switches/:id', desc: 'One Switch' },
  { method: 'POST', path: '/v1/switches/:id/on', desc: 'Turn on → Switch' },
  { method: 'POST', path: '/v1/switches/:id/off', desc: 'Turn off → Switch' },
  { method: 'POST', path: '/v1/switches/:id/toggle', desc: 'Toggle (unknown state turns on) → Switch' },
  { method: 'PATCH', path: '/v1/switches/:id', desc: 'Body { "state": "on" | "off" } → Switch' },
  { method: 'GET', path: '/v1/openapi.json', desc: 'OpenAPI 3 description (public, no key)' },
];

const ERRORS: { status: number; code: string; meaning: string }[] = [
  { status: 400, code: 'invalid_request', meaning: 'Bad parameter or body (e.g. state not "on"/"off")' },
  { status: 400, code: 'invalid_json', meaning: 'Body is not valid JSON' },
  { status: 401, code: 'missing_api_key', meaning: 'No Authorization: Bearer sk_… header' },
  { status: 401, code: 'invalid_api_key', meaning: 'Unknown or revoked key (app/login tokens are rejected too)' },
  { status: 404, code: 'not_found', meaning: 'No such switch/device in your households' },
  { status: 405, code: 'method_not_allowed', meaning: 'Wrong HTTP method for this path' },
  { status: 413, code: 'payload_too_large', meaning: 'Request body too large' },
  { status: 429, code: 'rate_limited', meaning: 'Too many requests — back off and retry' },
  { status: 500, code: 'internal_error', meaning: 'Unexpected server error' },
  { status: 502, code: 'device_error', meaning: 'The device rejected the command' },
  { status: 503, code: 'device_offline', meaning: 'The device is not connected' },
  { status: 504, code: 'device_timeout', meaning: 'The device didn’t answer within 10 s' },
];

function MethodBadge({ method }: { method: string }) {
  const tone =
    method === 'GET'
      ? 'bg-sky-500/15 text-sky-600 dark:text-sky-300'
      : method === 'POST'
        ? 'bg-primary/15 text-brand-ink'
        : 'bg-amber-500/15 text-amber-700 dark:text-amber-300';
  return (
    <span className={`inline-flex w-14 justify-center rounded-md px-1.5 py-0.5 font-mono text-[11px] font-bold ${tone}`}>
      {method}
    </span>
  );
}

export function ApiDocs({ apiUrl }: { apiUrl: string }) {
  const base = apiUrl;
  const auth = '-H "Authorization: Bearer $SC_API_KEY"';

  const quickstart = `export SC_API_KEY="sk_…"   # from the API keys tab

# Who am I?
curl ${auth} ${base}/v1/me

# List every switch (optionally ?deviceId=esp8266-3d87ce)
curl ${auth} ${base}/v1/switches

# Read one switch
curl ${auth} ${base}/v1/switches/${EXAMPLE_ID}

# Turn on / off / toggle
curl -X POST ${auth} ${base}/v1/switches/${EXAMPLE_ID}/on
curl -X POST ${auth} ${base}/v1/switches/${EXAMPLE_ID}/off
curl -X POST ${auth} ${base}/v1/switches/${EXAMPLE_ID}/toggle

# Set an explicit state
curl -X PATCH ${auth} -H "Content-Type: application/json" \\
  -d '{"state":"off"}' ${base}/v1/switches/${EXAMPLE_ID}`;

  const switchJson = `{
  "id": "${EXAMPLE_ID}",
  "deviceId": "esp8266-3d87ce",
  "deviceName": "Living room panel",
  "channel": 0,
  "name": "Ceiling light",
  "zone": "Living room",
  "state": "on",
  "online": true,
  "updatedAt": "2026-09-24T10:15:02.000Z"
}`;

  const errorJson = `HTTP/1.1 503 Service Unavailable
{ "error": { "code": "device_offline", "message": "device is offline" } }`;

  const haConfig = `# secrets.yaml
smart_control_auth: "Bearer sk_…"

# configuration.yaml
rest_command:
  smart_control:
    url: "${base}/v1/switches/{{ switch_id }}/{{ action }}"   # action: on | off | toggle
    method: post
    headers:
      authorization: !secret smart_control_auth

# usage in an automation / script:
# - action: rest_command.smart_control
#   data: { switch_id: "${EXAMPLE_ID}", action: "toggle" }`;

  const hookDocs = `GET|POST ${base}/v1/hook/<token>/on
GET|POST ${base}/v1/hook/<token>/off
GET|POST ${base}/v1/hook/<token>/toggle
GET|POST ${base}/v1/hook/<token>/status          # → Switch JSON
GET      ${base}/v1/hook/<token>/status?format=text   # → on | off | unknown`;

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BookOpen className="h-5 w-5 text-brand-ink" /> REST API
          </CardTitle>
          <CardDescription>
            Base URL <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{base}</code> · JSON over
            HTTPS · authenticate every request with{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">Authorization: Bearer sk_…</code>
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full min-w-[560px] text-sm">
              <tbody className="divide-y">
                {ENDPOINTS.map((e) => (
                  <tr key={e.method + e.path}>
                    <td className="w-16 py-2.5 pl-4 pr-2 align-top">
                      <MethodBadge method={e.method} />
                    </td>
                    <td className="whitespace-nowrap px-2 py-2.5 align-top font-mono text-[13px]">{e.path}</td>
                    <td className="py-2.5 pl-2 pr-4 align-top text-muted-foreground">{e.desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-sm text-muted-foreground">
            Switch ids are <code className="font-mono">&lt;deviceId&gt;:&lt;channel&gt;</code> (channels start at 0),
            e.g. <code className="font-mono">{EXAMPLE_ID}</code>. <code className="font-mono">state</code> is{' '}
            <code className="font-mono">&quot;on&quot;</code>, <code className="font-mono">&quot;off&quot;</code> or{' '}
            <code className="font-mono">&quot;unknown&quot;</code>. Single-switch endpoints
            return the bare Switch object; list endpoints wrap it.
          </p>
          <div>
            <h4 className="mb-1.5 text-sm font-semibold">Quick start</h4>
            <CodeBlock code={quickstart} />
          </div>
          <div className="grid gap-5 lg:grid-cols-2">
            <div>
              <h4 className="mb-1.5 text-sm font-semibold">Switch object</h4>
              <CodeBlock code={switchJson} />
            </div>
            <div>
              <h4 className="mb-1.5 text-sm font-semibold">Home Assistant (with an API key)</h4>
              <CodeBlock code={haConfig} />
            </div>
          </div>
          <a
            href={`${base}/v1/openapi.json`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex w-fit items-center gap-1.5 text-sm font-semibold text-brand-ink hover:underline"
          >
            OpenAPI specification (openapi.json) <ExternalLink className="h-4 w-4" />
          </a>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TriangleAlert className="h-5 w-5 text-brand-ink" /> Errors
          </CardTitle>
          <CardDescription>Every error uses the same shape.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <CodeBlock code={errorJson} />
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full min-w-[480px] text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="py-2 pl-4 pr-2 font-semibold">HTTP</th>
                  <th className="px-2 py-2 font-semibold">code</th>
                  <th className="py-2 pl-2 pr-4 font-semibold">Meaning</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {ERRORS.map((e) => (
                  <tr key={e.code}>
                    <td className="py-2 pl-4 pr-2 font-mono">{e.status}</td>
                    <td className="px-2 py-2 font-mono text-[13px]">{e.code}</td>
                    <td className="py-2 pl-2 pr-4 text-muted-foreground">{e.meaning}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Link2 className="h-5 w-5 text-brand-ink" /> Hook URLs
            </CardTitle>
            <CardDescription>
              No headers — the secret token in the path is the credential. Failures of any kind return a
              uniform 404. <code className="font-mono">HEAD</code> on action URLs returns 405 and never actuates.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CodeBlock code={hookDocs} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Gauge className="h-5 w-5 text-brand-ink" /> Rate limits
            </CardTitle>
            <CardDescription>Exceeding a limit returns 429 rate_limited.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-2 text-sm">
              <li className="flex items-center justify-between gap-3">
                <span>Requests per API key</span>
                <Badge variant="secondary">120 / min</Badge>
              </li>
              <li className="flex items-center justify-between gap-3">
                <span>Failed authentications per IP</span>
                <Badge variant="secondary">30 / 15 min</Badge>
              </li>
              <li className="flex items-center justify-between gap-3">
                <span>Hook calls per IP</span>
                <Badge variant="secondary">60 / min</Badge>
              </li>
              <li className="flex items-center justify-between gap-3">
                <span>Hook calls per token</span>
                <Badge variant="secondary">30 / min</Badge>
              </li>
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
