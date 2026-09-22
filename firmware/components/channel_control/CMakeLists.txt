idf_component_register(
    SRCS "channel_control.c"
    INCLUDE_DIRS "include"
    PRIV_REQUIRES config_store relay_hal cloud_client esp_timer log
)
