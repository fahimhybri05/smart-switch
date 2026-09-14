#pragma once

#include <stdint.h>
#include "esp_err.h"

// Advertises _esp-switch._tcp on the LAN (spec §4) with TXT records
// device_id/board_type/channel_count. Call after STA has an IP — mDNS
// should follow netif-up so it advertises on the right interface.
esp_err_t mdns_advertise_start(const char *device_id, const char *name,
                                const char *board_type, uint8_t channel_count);

esp_err_t mdns_advertise_stop(void);
