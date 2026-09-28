#include "local_schedule.h"

#include <LittleFS.h>
#include <sys/time.h>
#include <time.h>

#include "board_config.h"
#include "channel_control.h"
#include "cloud_client.h"
#include "relay_hal.h"

static const char *SCHEDULES_PATH = "/schedules.json";
static const uint8_t MAX_SCHEDULES = 16;
static const time_t MIN_VALID_EPOCH = 1700000000; // Nov 2023 — anything earlier = unset

static LocalSchedule s_items[MAX_SCHEDULES];
static uint8_t s_count = 0;
static uint16_t s_nextId = 1;
static int16_t s_tzOffsetMin = 0;

static long s_lastMinuteKey = -1;
static unsigned long s_lastCheckMs = 0;

static void save() {
  JsonDocument doc;
  doc["tz"] = s_tzOffsetMin;
  doc["next"] = s_nextId;
  JsonArray arr = doc["items"].to<JsonArray>();
  for (uint8_t i = 0; i < s_count; i++) {
    const LocalSchedule &s = s_items[i];
    JsonObject o = arr.add<JsonObject>();
    o["id"] = s.id;
    o["ch"] = s.channel;
    o["on"] = s.on;
    o["h"] = s.hour;
    o["m"] = s.minute;
    o["d"] = s.days;
    o["en"] = s.enabled;
  }
  // Same tmp + atomic-rename pattern as config_store.cpp's save().
  File f = LittleFS.open("/schedules.json.tmp", "w");
  if (!f) {
    Serial.println("schedules: failed to open tmp file; NOT saved");
    return;
  }
  serializeJson(doc, f);
  f.close();
  if (!LittleFS.rename("/schedules.json.tmp", SCHEDULES_PATH)) {
    Serial.println("schedules: rename failed; NOT saved");
  }
}

static void load() {
  s_count = 0;
  File f = LittleFS.open(SCHEDULES_PATH, "r");
  if (!f) return;
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, f);
  f.close();
  if (err) return;
  s_tzOffsetMin = doc["tz"] | 0;
  s_nextId = doc["next"] | 1;
  for (JsonObject o : doc["items"].as<JsonArray>()) {
    if (s_count >= MAX_SCHEDULES) break;
    LocalSchedule &s = s_items[s_count++];
    s.id = o["id"] | 0;
    s.channel = o["ch"] | 0;
    s.on = o["on"] | true;
    s.hour = o["h"] | 0;
    s.minute = o["m"] | 0;
    s.days = o["d"] | 0x7F;
    s.enabled = o["en"] | true;
    if (s.id >= s_nextId) s_nextId = s.id + 1;
  }
}

void localScheduleBegin() {
  // Background SNTP — harmless while offline, keeps the clock right once
  // the device has internet. Offsets applied manually (s_tzOffsetMin), so
  // the libc clock stays UTC.
  configTime(0, 0, "pool.ntp.org", "time.google.com");
  load();
}

String localScheduleListJson() {
  JsonDocument doc;
  JsonArray arr = doc["items"].to<JsonArray>();
  for (uint8_t i = 0; i < s_count; i++) {
    const LocalSchedule &s = s_items[i];
    JsonObject o = arr.add<JsonObject>();
    o["id"] = s.id;
    o["channel"] = s.channel;
    o["on"] = s.on;
    o["hour"] = s.hour;
    o["minute"] = s.minute;
    o["days"] = s.days;
    o["enabled"] = s.enabled;
  }
  String out;
  serializeJson(doc, out);
  return out;
}

bool localScheduleUpsert(JsonVariantConst in, String *err) {
  int channel = in["channel"] | -1;
  int hour = in["hour"] | -1;
  int minute = in["minute"] | -1;
  int days = in["days"] | 0x7F;
  if (channel < 0 || channel >= relayHalChannelCount()) {
    *err = "invalid channel";
    return false;
  }
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    *err = "invalid time";
    return false;
  }
  if (days <= 0 || days > 0x7F) {
    *err = "pick at least one day";
    return false;
  }

  uint16_t id = in["id"] | 0;
  LocalSchedule *target = nullptr;
  if (id != 0) {
    for (uint8_t i = 0; i < s_count; i++) {
      if (s_items[i].id == id) { target = &s_items[i]; break; }
    }
    if (target == nullptr) {
      *err = "schedule not found";
      return false;
    }
  } else {
    if (s_count >= MAX_SCHEDULES) {
      *err = "schedule limit reached (16)";
      return false;
    }
    target = &s_items[s_count++];
    target->id = s_nextId++;
  }
  target->channel = (uint8_t)channel;
  target->on = in["on"] | true;
  target->hour = (uint8_t)hour;
  target->minute = (uint8_t)minute;
  target->days = (uint8_t)days;
  target->enabled = in["enabled"] | true;
  save();
  return true;
}

bool localScheduleDelete(uint16_t id) {
  for (uint8_t i = 0; i < s_count; i++) {
    if (s_items[i].id == id) {
      for (uint8_t j = i; j + 1 < s_count; j++) s_items[j] = s_items[j + 1];
      s_count--;
      save();
      return true;
    }
  }
  return false;
}

void localClockSet(time_t utcEpoch, int16_t tzOffsetMin) {
  timeval tv = {utcEpoch, 0};
  settimeofday(&tv, nullptr);
  s_lastMinuteKey = -1; // re-arm: don't treat the jump as a missed minute
  if (tzOffsetMin != s_tzOffsetMin) {
    s_tzOffsetMin = tzOffsetMin;
    save();
  }
  Serial.printf("clock: set from phone, utc=%ld tz=%+d min\n", (long)utcEpoch, tzOffsetMin);
}

bool localClockValid() { return time(nullptr) >= MIN_VALID_EPOCH; }

time_t localClockNowUtc() { return time(nullptr); }

int16_t localClockTzOffsetMin() { return s_tzOffsetMin; }

void localScheduleLoop() {
  if (millis() - s_lastCheckMs < 1000) return;
  s_lastCheckMs = millis();
  if (!localClockValid()) return;

  time_t local = time(nullptr) + (time_t)s_tzOffsetMin * 60;
  long minuteKey = (long)(local / 60);
  if (minuteKey == s_lastMinuteKey) return;
  bool firstTick = s_lastMinuteKey < 0;
  s_lastMinuteKey = minuteKey;
  // Only fire on a real minute rollover, and only while offline — the
  // backend runs the normal schedules whenever it can reach the device.
  if (firstTick || cloudClientIsConnected()) return;

  struct tm t;
  gmtime_r(&local, &t);
  for (uint8_t i = 0; i < s_count; i++) {
    const LocalSchedule &s = s_items[i];
    if (!s.enabled || s.hour != t.tm_hour || s.minute != t.tm_min) continue;
    if (!(s.days & (1 << t.tm_wday))) continue;
    Serial.printf("schedules: #%u -> ch%u %s\n", s.id, s.channel, s.on ? "ON" : "OFF");
    channelControlSetState(s.channel, s.on);
  }
}
