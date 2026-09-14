idf_component_register(
    SRCS "http_api.c" "http_uri_parse.c"
    INCLUDE_DIRS "include"
    PRIV_REQUIRES esp_http_server json mbedtls log config_store relay_hal schedule_exec
                  http_auth wifi_reconfig cloud_client
)
