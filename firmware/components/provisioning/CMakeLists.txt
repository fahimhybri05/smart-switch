idf_component_register(
    SRCS "provisioning.c"
    INCLUDE_DIRS "include"
    PRIV_REQUIRES wifi_provisioning esp_wifi esp_netif esp_event config_store log
)
