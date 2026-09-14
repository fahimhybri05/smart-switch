idf_component_register(
    SRCS "cloud_client.c"
    INCLUDE_DIRS "include"
    PRIV_REQUIRES config_store relay_hal provisioning esp_http_client
                  esp_websocket_client json esp_timer log
)
