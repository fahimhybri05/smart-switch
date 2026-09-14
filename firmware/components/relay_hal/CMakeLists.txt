idf_component_register(
    SRCS "relay_hal.c"
    INCLUDE_DIRS "include"
    REQUIRES esp_driver_gpio
    PRIV_REQUIRES log
)
