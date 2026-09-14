idf_component_register(
    SRCS "config_store.c"
    INCLUDE_DIRS "include"
    PRIV_REQUIRES json log esp_hw_support esp_app_format
)
