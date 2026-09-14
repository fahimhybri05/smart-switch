#pragma once

#include <stdbool.h>
#include "esp_err.h"
#include "config_store.h"

// Starts SNTP (non-blocking) and the 1Hz scheduler task. Safe to call before
// WiFi STA is connected — SNTP retries opportunistically once network is up;
// the scheduler self-gates on the DS3231's oscillator-stop-flag until time
// is known-good, so it never fires on garbage time. Assumes ds3231_init()
// has already been called by the caller (main.c) against the shared I2C bus.
esp_err_t schedule_exec_start(void);

// Create (in->id[0]=='\0') or update (in->id matches an existing schedule) a
// schedule. Validates channel_idx/type/action/time-format, generates the id
// on create, arms/re-arms countdown timers, persists via config_store, and
// writes the final stored form to *out.
esp_err_t schedule_exec_upsert(const ss_schedule_t *in, ss_schedule_t *out);
esp_err_t schedule_exec_delete(const char *id);

bool schedule_exec_time_is_known_good(void);

// Diagnostic only (exposed via GET /api/info) — current epoch as the
// scheduler sees it (DS3231 if OSF-clear, else SNTP-synced system clock).
int64_t schedule_exec_now_epoch(void);
