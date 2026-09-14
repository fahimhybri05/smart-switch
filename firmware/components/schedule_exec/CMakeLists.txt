idf_component_register(
    SRCS "schedule_exec.c"
    INCLUDE_DIRS "include"
    PRIV_REQUIRES ds3231 config_store relay_hal esp_netif lwip log cloud_client
)
