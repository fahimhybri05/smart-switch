idf_component_register(
    SRCS "main.c"
    INCLUDE_DIRS "."
    PRIV_REQUIRES config_store relay_hal provisioning mdns_advertise ds3231 schedule_exec
                  http_api wifi_reconfig recovery_button ota cloud_client
                  nvs_flash esp_event esp_netif esp_wifi esp_app_format esp_driver_i2c
                  app_update log
)
