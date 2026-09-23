#pragma once

#include <Arduino.h>

// Starts the persistent cloud-tunnel connection (arduinoWebSockets handles
// its own reconnect-with-backoff once started). Call once at boot, after
// configStore.begin(). Safe to call even before WiFi connects — the
// underlying client only actually dials once wifiProvisioningIsConnected().
void cloudClientBegin();

// Must be called every loop() iteration.
void cloudClientLoop();

// Best-effort unsolicited push of a channel's new state, for a change that
// didn't originate from a cloud-relayed command — call from
// channelControlSetState() itself, regardless of what triggered the change.
// No-op if the tunnel isn't currently connected — the next reconnect
// republishes full current state anyway (see publishFullState() in
// cloud_client.cpp).
void cloudClientNotifyStateChanged(uint8_t channelIdx, bool on);

// True if the WS tunnel to the backend is currently connected (and has sent
// its auth frame). httpApiForward() (http_api.cpp) fails fast with 503 when
// this is false rather than blocking on a doomed round-trip.
bool cloudClientIsConnected();

// Device-initiated RPC used by httpApiForward() for every LAN request that
// needs a backend decision. Only one can be outstanding at a time —
// ESP8266WebServer serves one client synchronously, so this is a single
// pending-slot, not a map: a second call while one is already in flight
// fails immediately rather than clobbering it. Sends
// {reqId, method, path, body} over the tunnel, then pumps the WebSocket
// client (s_ws.loop()) and checks elapsed time until the matching
// {reqId, status, body} response arrives or timeoutMs elapses. Returns
// false (outStatus/outBody left untouched) on timeout, if the tunnel drops
// mid-wait, or if the tunnel isn't connected at all.
bool cloudClientForward(const char *method, const char *path, const char *bodyJson,
                         int *outStatus, String *outBody, uint32_t timeoutMs);
