idf_component_register(
    SRCS "recovery_button.c"
    INCLUDE_DIRS "include"
    PRIV_REQUIRES esp_driver_gpio wifi_provisioning esp_system log
)
