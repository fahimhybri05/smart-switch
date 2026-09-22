#include "schedule_exec.h"

#include <RTClib.h>
#include <Wire.h>
#include <math.h>
#include <time.h>

#include "channel_control.h"
#include "config_store.h"
#include "relay_hal.h"

static RTC_DS3231 s_rtc;
static bool s_rtcOk = false;
static volatile bool s_timeKnownGood = false;
static unsigned long s_lastTickMs = 0;

struct FireGuard {
  char id[12] = {0};
  int64_t lastFiredMinute = -1;
};
static FireGuard s_fireGuard[SS_MAX_SCHEDULES];

static FireGuard *guardFor(const char *id) {
  for (auto &g : s_fireGuard) {
    if (strcmp(g.id, id) == 0) return &g;
  }
  for (auto &g : s_fireGuard) {
    if (g.id[0] == '\0') {
      strlcpy(g.id, id, sizeof(g.id));
      g.lastFiredMinute = -1;
      return &g;
    }
  }
  return nullptr; // table full — shouldn't happen, sized to SS_MAX_SCHEDULES
}

static bool parseHhMm(const char *s, int *h, int *m) {
  if (strlen(s) != 5 || s[2] != ':') return false;
  for (int i = 0; i < 5; i++) {
    if (i != 2 && !isdigit((unsigned char)s[i])) return false;
  }
  *h = (s[0] - '0') * 10 + (s[1] - '0');
  *m = (s[3] - '0') * 10 + (s[4] - '0');
  return (*h >= 0 && *h < 24 && *m >= 0 && *m < 60);
}

// Called once SNTP has synced (registered via settimeofday_cb in
// scheduleExecBegin) — heals the DS3231 from the network-synced system
// clock, same role as the ESP32 firmware's sntp_sync_cb.
static void onTimeSynced() {
  time_t epoch = time(nullptr);
  if (s_rtcOk) {
    s_rtc.adjust(DateTime((uint32_t)epoch)); // also clears the OSF bit
  }
  s_timeKnownGood = true;
}

// Primary: DS3231. Fallback: SNTP-synced system clock, only on I2C failure.
static time_t getNowEpoch() {
  if (s_rtcOk) {
    return s_rtc.now().unixtime();
  }
  return time(nullptr);
}

static void fire(SsSchedule &s) {
  bool on = strcmp(s.action, "ON") == 0;
  channelControlSetState(s.channel_idx, on);
}

// Standard "Sunrise/Sunset Algorithm" (Almanac for Computers, 1990 — same
// well-known formula most embedded sunrise libraries use; accurate to
// ~±1-2 minutes, sufficient for a relay timer, not navigation-grade).
// Returns local minutes-since-midnight (0..1439) for the local calendar
// date's sunrise/sunset, or -1 if the sun doesn't rise/set that day at this
// latitude (polar day/night). Caller must separately check
// configStore.cfg().locationSet before trusting a non-negative result as
// meaningful (this function computes unconditionally off whatever lat/lon
// it's given).
static int computeLocalSolarMinutes(int yday, double lat, double lon, int16_t utcOffsetMin,
                                     bool isSunrise) {
  double N = yday + 1;
  double lngHour = lon / 15.0;
  double t = isSunrise ? (N + ((6.0 - lngHour) / 24.0)) : (N + ((18.0 - lngHour) / 24.0));
  double M = (0.9856 * t) - 3.289;
  double L = M + (1.916 * sin(M * M_PI / 180.0)) + (0.020 * sin(2 * M * M_PI / 180.0)) + 282.634;
  L = fmod(L, 360.0); if (L < 0) L += 360.0;
  double RA = atan(0.91764 * tan(L * M_PI / 180.0)) * 180.0 / M_PI;
  RA = fmod(RA, 360.0); if (RA < 0) RA += 360.0;
  double Lq = floor(L / 90.0) * 90.0;
  double RAq = floor(RA / 90.0) * 90.0;
  RA = (RA + (Lq - RAq)) / 15.0;
  double sinDec = 0.39782 * sin(L * M_PI / 180.0);
  double cosDec = cos(asin(sinDec));
  double cosH = (cos(90.833 * M_PI / 180.0) - (sinDec * sin(lat * M_PI / 180.0)))
                / (cosDec * cos(lat * M_PI / 180.0));
  if (cosH > 1.0 || cosH < -1.0) {
    return -1;
  }
  double H = isSunrise ? (360.0 - acos(cosH) * 180.0 / M_PI) : (acos(cosH) * 180.0 / M_PI);
  H = H / 15.0;
  double T = H + RA - (0.06571 * t) - 6.622;
  double UT = fmod(T - lngHour, 24.0);
  if (UT < 0) UT += 24.0;
  double localMinutes = fmod(UT * 60.0 + utcOffsetMin, 1440.0);
  if (localMinutes < 0) localMinutes += 1440.0;
  return (int)(localMinutes + 0.5);
}

static void selfDisable(SsSchedule s) {
  s.enabled = false;
  configStore.upsertSchedule(s);
}

static void schedulerTick() {
  if (!s_timeKnownGood) {
    return;
  }

  time_t epoch = getNowEpoch();
  int64_t currentMinute = epoch / 60;

  // Clock-type schedules are matched in local time; countdown schedules and
  // the fire-guard's currentMinute stay in raw UTC epoch since they're
  // duration/uniqueness based, not wall-clock. The RTC/SNTP clock itself is
  // never touched by the offset — it's applied here, at match time, only.
  int16_t utcOffsetMin = configStore.cfg().utc_offset_min;
  time_t localEpoch = epoch + (time_t)utcOffsetMin * 60;
  struct tm localTm;
  gmtime_r(&localEpoch, &localTm);
  int isoWday = (localTm.tm_wday == 0) ? 7 : localTm.tm_wday;

  SsConfig &cfg = configStore.cfg();

  // Sunrise/sunset for the local calendar date, cached per-day since the
  // trig-heavy computation is unnecessary (and wasteful on this cooperative
  // single-loop chip) to redo every tick — only the date matters, not the
  // time of day.
  static int s_solarCacheYear = -1, s_solarCacheYday = -1;
  static int s_sunriseMin = -1, s_sunsetMin = -1;
  if (cfg.locationSet &&
      (localTm.tm_year != s_solarCacheYear || localTm.tm_yday != s_solarCacheYday)) {
    s_solarCacheYear = localTm.tm_year;
    s_solarCacheYday = localTm.tm_yday;
    s_sunriseMin = computeLocalSolarMinutes(localTm.tm_yday, cfg.latitude, cfg.longitude,
                                             utcOffsetMin, true);
    s_sunsetMin = computeLocalSolarMinutes(localTm.tm_yday, cfg.latitude, cfg.longitude,
                                            utcOffsetMin, false);
  }

  for (uint8_t i = 0; i < cfg.schedule_count; i++) {
    SsSchedule &s = cfg.schedules[i];
    if (!s.enabled) continue;

    if (strcmp(s.type, "countdown") == 0) {
      if (s.countdown_started_at > 0 && epoch >= s.countdown_started_at + (time_t)s.duration_s) {
        fire(s);
        selfDisable(s);
      }
      continue;
    }

    bool isSolar = strcmp(s.type, "sunrise") == 0 || strcmp(s.type, "sunset") == 0;
    int h, m;
    if (isSolar) {
      if (!cfg.locationSet) continue;
      int eventMin = (strcmp(s.type, "sunrise") == 0) ? s_sunriseMin : s_sunsetMin;
      if (eventMin < 0) continue; // polar day/night — no event today
      int target = ((eventMin + s.solarOffsetMin) % 1440 + 1440) % 1440;
      h = target / 60;
      m = target % 60;
    } else {
      if (!parseHhMm(s.time, &h, &m)) continue;
    }

    struct tm nowTm;
    time_t nowEpoch = epoch;
    gmtime_r(&nowEpoch, &nowTm);
    // A window, not an exact nowTm.tm_sec == 0 match: loop() is cooperative
    // and single-threaded (shares time with the HTTP server, WS client,
    // mDNS), so a given tick isn't guaranteed to land exactly on the second
    // boundary — requiring an exact match could silently skip a whole day's
    // fire. Safe to widen: the fire-guard below (keyed by currentMinute)
    // already prevents firing more than once per minute regardless of how
    // many ticks land inside this window.
    bool timeMatch = (localTm.tm_hour == h && localTm.tm_min == m && nowTm.tm_sec < 5);
    if (!timeMatch) continue;
    if (strcmp(s.type, "weekly") == 0 && !(s.days_mask & (1 << (isoWday - 1)))) continue;

    FireGuard *g = guardFor(s.id);
    if (g != nullptr && g->lastFiredMinute == currentMinute) continue; // already fired this exact minute
    if (g != nullptr) g->lastFiredMinute = currentMinute;

    // Sunrise/sunset schedules do not self-disable after firing (same as
    // "daily"); only "once" self-disables.
    fire(s);
    if (strcmp(s.type, "once") == 0) {
      selfDisable(s);
    }
  }
}

void scheduleExecBegin() {
  Wire.begin(SS_I2C_SDA_GPIO, SS_I2C_SCL_GPIO);
  s_rtcOk = s_rtc.begin();
  if (s_rtcOk) {
    s_timeKnownGood = !s_rtc.lostPower(); // lostPower() reads the OSF bit
  } else {
    s_timeKnownGood = false;
  }

  settimeofday_cb(onTimeSynced);
  configTime(0, 0, "pool.ntp.org"); // UTC0 — never touches local-time math

  for (auto &g : s_fireGuard) {
    g.id[0] = '\0';
    g.lastFiredMinute = -1;
  }
}

void scheduleExecLoop() {
  unsigned long now = millis();
  if (now - s_lastTickMs < 1000) {
    return;
  }
  s_lastTickMs = now;
  schedulerTick();
}

bool scheduleExecTimeIsKnownGood() { return s_timeKnownGood; }

int64_t scheduleExecNowEpoch() { return (int64_t)getNowEpoch(); }

bool scheduleExecRtcPresent() { return s_rtcOk; }

void scheduleExecReleaseFireGuard(const char *id) {
  for (auto &g : s_fireGuard) {
    if (strcmp(g.id, id) == 0) {
      g.id[0] = '\0';
      g.lastFiredMinute = -1;
      return;
    }
  }
}
