idf_component_register(
    SRCS "ota.c"
    INCLUDE_DIRS "include"
    REQUIRES esp_http_server
    PRIV_REQUIRES app_update esp_partition mbedtls provisioning http_auth esp_system log
    EMBED_TXTFILES "ota_pubkey.pem"
)
