#pragma once
#include <Arduino.h>

// Central entry point for every backend-commanded/LAN-forwarded/physical-
// input-triggered channel state change. Applies interlock (if config's
// interlockEnabled and on==true, forces every other channel off first),
// then relayHalSetState, then configStore.setLastState (so the boot-time
// restore cache stays current) and cloudClientNotifyStateChanged, then
// arms/cancels that channel's inching auto-reverse timer per its channel's
// inchingMs. This is the ONLY function that should be called to change
// channel state outside of boot-time restore (main.cpp's restore of
// configStore.cfg().lastState[], which intentionally bypasses
// interlock/inching during boot).
void channelControlInit();
void channelControlSetState(uint8_t channelIdx, bool on);
// Must be called once per loop() iteration to service pending inching
// auto-reverse deadlines via millis() polling — no RTOS timers on this
// cooperative single-loop chip.
void channelControlLoop();
