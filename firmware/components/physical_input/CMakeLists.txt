idf_component_register(
    SRCS "physical_input.c"
    INCLUDE_DIRS "include"
    PRIV_REQUIRES config_store relay_hal channel_control esp_driver_gpio freertos log
)
