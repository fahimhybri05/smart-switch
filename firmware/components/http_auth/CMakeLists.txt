idf_component_register(
    SRCS "http_auth.c"
    INCLUDE_DIRS "include"
    REQUIRES esp_http_server
    PRIV_REQUIRES config_store mbedtls esp_timer lwip
)
