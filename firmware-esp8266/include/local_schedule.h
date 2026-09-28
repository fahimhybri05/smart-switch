#pragma once

#include <Arduino.h>
#include <ArduinoJson.h>

// Offline schedules + wall clock for the hotspot web UI (local_web.cpp).
//
// Normal schedules live on the backend and fire from there. These are a
// separate, device-local set, created from the offline page, that fire
// ONLY while the cloud link is down (!cloudClientIsConnected()) — so the
// two never double-fire. Stored in LittleFS (/schedules.json); wiped by
// factory reset along with everything else.
//
// Clock: SNTP whenever the device has internet, otherwise the phone's time
// (the offline page posts it on load). No RTC driver on this board yet, so
// after a reboot with no internet the clock stays unset — and schedules
// don't fire — until someone opens the page.

struct LocalSchedule {
  uint16_t id = 0;
  uint8_t channel = 0;
  bool on = true;       // action: true = ON, false = OFF
  uint8_t hour = 0;     // local time, 0-23
  uint8_t minute = 0;   // 0-59
  uint8_t days = 0x7F;  // bit0 = Sunday ... bit6 = Saturday
  bool enabled = true;
};

void localScheduleBegin();
void localScheduleLoop();

// {"items":[{id, channel, on, hour, minute, days, enabled}, ...]}
String localScheduleListJson();

// Creates (id missing/0) or replaces (existing id) one schedule from JSON.
// Returns false + a message in *err on invalid input or when full.
bool localScheduleUpsert(JsonVariantConst in, String *err);

bool localScheduleDelete(uint16_t id);

// Sets the clock from the phone: UTC epoch seconds + local offset
// (minutes east of UTC, e.g. +330 for IST).
void localClockSet(time_t utcEpoch, int16_t tzOffsetMin);
bool localClockValid();
time_t localClockNowUtc();
int16_t localClockTzOffsetMin();
