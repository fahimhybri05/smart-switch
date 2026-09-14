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
// didn't originate from a cloud-relayed command (a local LAN app call, or a
// schedule firing) — call from http_api's channel-state handler and from
// schedule_exec's fire(). No-op if the tunnel isn't currently connected —
// the next reconnect republishes full current state anyway.
void cloudClientNotifyStateChanged(uint8_t channelIdx, bool on);
