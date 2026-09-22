#include "ds3231.h"

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

static const char *TAG = "ds3231";
static i2c_master_dev_handle_t s_dev;

// schedule_exec.c's sntp_sync_cb() (LWIP/SNTP task) and scheduler_task's
// get_now()->ds3231_get_time() (schedule_exec's own task) both issue I2C
// transactions against s_dev from different tasks. ESP-IDF's i2c_master
// driver does NOT guarantee cross-call serialization on its own beyond a
// single transaction — take this mutex around every public function's I2C
// transaction(s) so two tasks never interleave on the bus.
static SemaphoreHandle_t s_mutex;

#define DS3231_ADDR 0x68
#define DS3231_REG_TIME 0x00
#define DS3231_REG_STATUS 0x0F
#define DS3231_OSF_BIT 0x80
#define I2C_TIMEOUT_MS 1000
// Mutex acquisition timeout — generous relative to I2C_TIMEOUT_MS since a
// held mutex only ever wraps one bounded I2C_TIMEOUT_MS-bounded transaction,
// so the wait should virtually never approach this.
#define MUTEX_TIMEOUT_MS 1000

static inline uint8_t bcd2dec(uint8_t bcd)
{
    return ((bcd >> 4) * 10) + (bcd & 0x0F);
}

static inline uint8_t dec2bcd(uint8_t dec)
{
    return (uint8_t)(((dec / 10) << 4) | (dec % 10));
}

esp_err_t ds3231_init(i2c_master_bus_handle_t bus)
{
    i2c_device_config_t dev_cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = DS3231_ADDR,
        .scl_speed_hz = 100000,
    };
    esp_err_t err = i2c_master_bus_add_device(bus, &dev_cfg, &s_dev);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "i2c_master_bus_add_device failed: %s", esp_err_to_name(err));
        return err;
    }

    s_mutex = xSemaphoreCreateMutex();
    if (s_mutex == NULL) {
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

esp_err_t ds3231_get_time(ds3231_time_t *out)
{
    if (xSemaphoreTake(s_mutex, pdMS_TO_TICKS(MUTEX_TIMEOUT_MS)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    uint8_t reg = DS3231_REG_TIME;
    uint8_t buf[7];
    esp_err_t err = i2c_master_transmit_receive(s_dev, &reg, 1, buf, sizeof(buf), I2C_TIMEOUT_MS);
    if (err != ESP_OK) {
        xSemaphoreGive(s_mutex);
        return err;
    }

    out->second = bcd2dec(buf[0] & 0x7F);
    out->minute = bcd2dec(buf[1] & 0x7F);
    out->hour = bcd2dec(buf[2] & 0x3F);   // 24h mode: bit6=0, bits5-4=tens(0-2), bits3-0=units
    out->weekday = bcd2dec(buf[3] & 0x07);
    out->day = bcd2dec(buf[4] & 0x3F);
    out->month = bcd2dec(buf[5] & 0x1F);  // bit7 = century, ignored — valid through 2099
    out->year = 2000 + bcd2dec(buf[6]);

    xSemaphoreGive(s_mutex);
    return ESP_OK;
}

esp_err_t ds3231_set_time(const ds3231_time_t *in)
{
    uint8_t buf[8] = {
        DS3231_REG_TIME,
        dec2bcd(in->second),
        dec2bcd(in->minute),
        (uint8_t)(dec2bcd(in->hour) & 0x3F), // force 24h mode (bit6=0)
        dec2bcd(in->weekday),
        dec2bcd(in->day),
        dec2bcd(in->month),
        dec2bcd((uint8_t)(in->year - 2000)),
    };

    if (xSemaphoreTake(s_mutex, pdMS_TO_TICKS(MUTEX_TIMEOUT_MS)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    esp_err_t err = i2c_master_transmit(s_dev, buf, sizeof(buf), I2C_TIMEOUT_MS);
    xSemaphoreGive(s_mutex);
    return err;
}

esp_err_t ds3231_get_osf(bool *osf_set)
{
    if (xSemaphoreTake(s_mutex, pdMS_TO_TICKS(MUTEX_TIMEOUT_MS)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    uint8_t reg = DS3231_REG_STATUS;
    uint8_t status;
    esp_err_t err = i2c_master_transmit_receive(s_dev, &reg, 1, &status, 1, I2C_TIMEOUT_MS);
    if (err != ESP_OK) {
        xSemaphoreGive(s_mutex);
        return err;
    }
    *osf_set = (status & DS3231_OSF_BIT) != 0;

    xSemaphoreGive(s_mutex);
    return ESP_OK;
}

esp_err_t ds3231_clear_osf(void)
{
    if (xSemaphoreTake(s_mutex, pdMS_TO_TICKS(MUTEX_TIMEOUT_MS)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    uint8_t reg = DS3231_REG_STATUS;
    uint8_t status;
    esp_err_t err = i2c_master_transmit_receive(s_dev, &reg, 1, &status, 1, I2C_TIMEOUT_MS);
    if (err != ESP_OK) {
        xSemaphoreGive(s_mutex);
        return err;
    }

    status &= (uint8_t)~DS3231_OSF_BIT;
    uint8_t buf[2] = {DS3231_REG_STATUS, status};
    err = i2c_master_transmit(s_dev, buf, sizeof(buf), I2C_TIMEOUT_MS);

    xSemaphoreGive(s_mutex);
    return err;
}
