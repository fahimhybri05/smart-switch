#include "provisioning.h"

#include <string.h>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "wifi_provisioning/manager.h"
#include "wifi_provisioning/scheme_softap.h"

#include "config_store.h"

static const char *TAG = "provisioning";
static bool s_provisioned = false;
static EventGroupHandle_t s_wifi_event_group;
static volatile bool s_auto_reconnect_suspended = false;

// This is one of potentially several independent handlers on the same
// default event loop — wifi_reconfig.c registers its own separate handler
// for the same WIFI_EVENT/IP_EVENT bases to observe test-connect outcomes;
// ESP-IDF's event loop dispatches to every registered handler, so no direct
// dependency between the two components is needed here.
static void wifi_event_handler(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg;
    (void)data;

    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        if (!s_auto_reconnect_suspended) {
            esp_wifi_connect();
        }
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        xEventGroupSetBits(s_wifi_event_group, PROVISIONING_WIFI_READY_BIT);
    }
}

static void prov_event_handler(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg;
    (void)base;

    switch (id) {
    case WIFI_PROV_START:
        ESP_LOGI(TAG, "provisioning started");
        break;
    case WIFI_PROV_CRED_RECV: {
        wifi_sta_config_t *cfg = (wifi_sta_config_t *)data;
        ESP_LOGI(TAG, "received credentials for SSID '%s'", (const char *)cfg->ssid);
        break;
    }
    case WIFI_PROV_CRED_FAIL: {
        wifi_prov_sta_fail_reason_t *reason = (wifi_prov_sta_fail_reason_t *)data;
        ESP_LOGW(TAG, "provisioning failed: %s",
                 *reason == WIFI_PROV_STA_AUTH_ERROR ? "auth error" : "AP not found");
        wifi_prov_mgr_reset_sm_state_on_failure();
        break;
    }
    case WIFI_PROV_CRED_SUCCESS:
        ESP_LOGI(TAG, "provisioning credentials accepted");
        break;
    case WIFI_PROV_END:
        wifi_prov_mgr_deinit();
        break;
    default:
        break;
    }
}

// Set via POST /api/network (http_api.c) + persisted by config_store — only
// meaningful on the "already provisioned" boot path below; a device being
// provisioned for the first time has no static IP configured yet (that's
// only settable once the device is already reachable). See docs/plan.md.
static void apply_static_ip_if_configured(void)
{
    ss_config_t cfg;
    config_store_get(&cfg);
    if (!cfg.static_ip_enabled) {
        return;
    }

    esp_netif_t *netif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    if (netif == NULL) {
        ESP_LOGE(TAG, "no STA netif to apply static IP to");
        return;
    }

    esp_netif_ip_info_t ip_info = {0};
    if (esp_netif_str_to_ip4(cfg.static_ip, &ip_info.ip) != ESP_OK ||
        esp_netif_str_to_ip4(cfg.static_gateway, &ip_info.gw) != ESP_OK ||
        esp_netif_str_to_ip4(cfg.static_subnet, &ip_info.netmask) != ESP_OK) {
        ESP_LOGE(TAG, "invalid stored static IP config, falling back to DHCP");
        return;
    }

    ESP_ERROR_CHECK(esp_netif_dhcpc_stop(netif));
    ESP_ERROR_CHECK(esp_netif_set_ip_info(netif, &ip_info));

    const char *dns = cfg.static_dns[0] != '\0' ? cfg.static_dns : cfg.static_gateway;
    esp_netif_dns_info_t dns_info = {0};
    if (esp_netif_str_to_ip4(dns, &dns_info.ip.u_addr.ip4) == ESP_OK) {
        dns_info.ip.type = ESP_IPADDR_TYPE_V4;
        esp_netif_set_dns_info(netif, ESP_NETIF_DNS_MAIN, &dns_info);
    }

    ESP_LOGI(TAG, "applied static IP %s (gw %s, mask %s)", cfg.static_ip, cfg.static_gateway,
             cfg.static_subnet);
}

esp_err_t provisioning_init(const char *device_id)
{
    s_wifi_event_group = xEventGroupCreate();
    if (s_wifi_event_group == NULL) {
        return ESP_ERR_NO_MEM;
    }

    esp_netif_create_default_wifi_sta();
    esp_netif_create_default_wifi_ap();

    wifi_init_config_t wifi_init_cfg = WIFI_INIT_CONFIG_DEFAULT();
    esp_err_t err = esp_wifi_init(&wifi_init_cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_wifi_init failed: %s", esp_err_to_name(err));
        return err;
    }

    // This is a mains-powered relay, not a battery device — no reason to
    // trade response latency for the radio power savings WiFi modem sleep
    // is for (IDF's default is WIFI_PS_MIN_MODEM). Reproduced live on the
    // ESP8266 port: the first request after even a few seconds idle paid a
    // multi-second wake-from-sleep tax before responding — set globally
    // here so it applies regardless of which branch below actually
    // connects (fresh provisioning vs. already-provisioned reconnect).
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_NONE));

    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &wifi_event_handler, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &wifi_event_handler, NULL));

    wifi_prov_mgr_config_t prov_cfg = {
        .scheme = wifi_prov_scheme_softap,
        .scheme_event_handler = WIFI_PROV_EVENT_HANDLER_NONE,
    };
    err = wifi_prov_mgr_init(prov_cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "wifi_prov_mgr_init failed: %s", esp_err_to_name(err));
        return err;
    }

    bool provisioned = false;
    err = wifi_prov_mgr_is_provisioned(&provisioned);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "wifi_prov_mgr_is_provisioned failed: %s", esp_err_to_name(err));
        wifi_prov_mgr_deinit();
        return err;
    }
    s_provisioned = provisioned;
    ESP_LOGI(TAG, "provisioned=%s", provisioned ? "true" : "false");

    if (!provisioned) {
        ESP_ERROR_CHECK(esp_event_handler_register(WIFI_PROV_EVENT, ESP_EVENT_ANY_ID, &prov_event_handler, NULL));

        char service_name[32];
        snprintf(service_name, sizeof(service_name), "SmartSwitch-%s", device_id);
        // POP == device_id. Known limitation, not a bug: device_id is also
        // visible in the broadcast SoftAP SSID, so this proves "you can read
        // a WiFi scan list," not real possession — acceptable given the
        // physical-proximity threat model and no secure element on this
        // hardware (no display either, so no per-device printed secret).
        char pop[24];
        snprintf(pop, sizeof(pop), "%s", device_id);

        err = wifi_prov_mgr_start_provisioning(WIFI_PROV_SECURITY_1, pop, service_name, NULL);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "wifi_prov_mgr_start_provisioning failed: %s", esp_err_to_name(err));
            return err;
        }
        ESP_LOGI(TAG, "SoftAP provisioning started: %s (open AP, security1 POP-gated)", service_name);
    } else {
        wifi_prov_mgr_deinit();
        apply_static_ip_if_configured();
        ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
        ESP_ERROR_CHECK(esp_wifi_start());
        // Connect happens via wifi_event_handler on WIFI_EVENT_STA_START.
    }

    return ESP_OK;
}

bool provisioning_is_provisioned(void)
{
    return s_provisioned;
}

EventGroupHandle_t provisioning_get_event_group(void)
{
    return s_wifi_event_group;
}

bool provisioning_wait_wifi_ready(TickType_t ticks_to_wait)
{
    EventBits_t bits = xEventGroupWaitBits(s_wifi_event_group, PROVISIONING_WIFI_READY_BIT,
                                            pdFALSE, pdTRUE, ticks_to_wait);
    return (bits & PROVISIONING_WIFI_READY_BIT) != 0;
}

void provisioning_set_auto_reconnect_suspended(bool suspended)
{
    s_auto_reconnect_suspended = suspended;
}
