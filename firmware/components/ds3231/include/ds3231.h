#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "driver/i2c_master.h"
#include "esp_err.h"

typedef struct {
    int16_t year;    // full year, e.g. 2026 (century bit ignored — valid through 2099)
    uint8_t month;   // 1-12
    uint8_t day;     // 1-31 (date-of-month)
    uint8_t weekday; // 1-7, ISO (1=Monday..7=Sunday)
    uint8_t hour;    // 0-23 (always programmed/read in 24h mode)
    uint8_t minute;
    uint8_t second;
} ds3231_time_t;

// Adds the DS3231 (addr 0x68) as a device on an already-created I2C master
// bus. Does not create the bus itself — caller owns bus lifetime.
esp_err_t ds3231_init(i2c_master_bus_handle_t bus);

esp_err_t ds3231_get_time(ds3231_time_t *out);
esp_err_t ds3231_set_time(const ds3231_time_t *in);

// Oscillator-stop-flag (status reg 0x0F bit7) — set when the RTC has lost
// power or has never been set. schedule_exec uses this to gate clock/
// countdown evaluation until the RTC is known-good.
esp_err_t ds3231_get_osf(bool *osf_set);
esp_err_t ds3231_clear_osf(void);
