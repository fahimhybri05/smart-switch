#pragma once

#include <Arduino.h>

// Starts SNTP (non-blocking) and DS3231 init. Call once at boot, after
// configStore.begin(). Cooperative — scheduleExecLoop() must be called
// every loop() iteration; it self-throttles to a 1Hz tick internally
// (same match logic as the ESP32 firmware's schedule_exec.c, ported to
// millis()-based cooperative scheduling instead of a FreeRTOS task).
void scheduleExecBegin();

void scheduleExecLoop();

bool scheduleExecTimeIsKnownGood();

// Frees this schedule id's slot in the internal per-schedule fire-guard
// table (sized to SS_MAX_SCHEDULES, never otherwise shrunk) so it can be
// reused by a future schedule. Call this whenever a schedule is actually
// deleted from config (see ConfigStore::deleteSchedule()) — otherwise the
// table permanently saturates with dead ids over the device's lifetime as
// schedules get edited/recreated, silently disabling the "already fired
// this minute" guard for every schedule created after that point. A no-op
// if id isn't currently occupying a slot.
void scheduleExecReleaseFireGuard(const char *id);

// Diagnostic only (exposed via GET /api/info) — current epoch as the
// scheduler sees it (RTC if healthy, else SNTP-synced system clock).
int64_t scheduleExecNowEpoch();

// Diagnostic only — true if the DS3231 ACKed on the I2C bus at boot (says
// nothing about whether its time is trustworthy — see
// scheduleExecTimeIsKnownGood() for that).
bool scheduleExecRtcPresent();
