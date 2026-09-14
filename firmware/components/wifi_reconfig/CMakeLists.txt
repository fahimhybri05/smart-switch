idf_component_register(
    SRCS "wifi_reconfig.c"
    INCLUDE_DIRS "include"
    REQUIRES esp_http_server
    PRIV_REQUIRES esp_wifi esp_netif esp_event esp_timer provisioning json http_auth log
)
