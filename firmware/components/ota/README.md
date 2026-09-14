# OTA signing

`ota_pubkey.pem` in this directory is embedded into the firmware at build
time (`EMBED_TXTFILES` in `CMakeLists.txt`) and used to verify every OTA
upload's detached signature before the new image is marked bootable.

**The committed `ota_pubkey.pem` right now is a throwaway development key**,
generated so the build stays green. Before shipping real devices, replace it
with a production key generated and stored properly (below), then re-sign
all release binaries with the new private key.

## One-time keypair generation (on a secure/offline machine)

```sh
openssl ecparam -name prime256v1 -genkey -noout -out ota_signing_key.pem   # PRIVATE — never commit
openssl ec -in ota_signing_key.pem -pubout -out ota_pubkey.pem             # commit this one
```

`ota_signing_key.pem` must never enter this repo — store it in a password
manager, an offline location, or a CI secret store. Copy the resulting
`ota_pubkey.pem` over this file and rebuild.

## Per-release signing

Whenever a new firmware binary is cut for GitHub Releases (spec §0's hosting
model):

```sh
openssl dgst -sha256 -sign ota_signing_key.pem -out firmware.sig firmware.bin
base64 -w0 firmware.sig > firmware.sig.b64
```

The contents of `firmware.sig.b64` is the exact value the app sends as the
`X-Firmware-Signature` request header on `POST /api/ota`. The request body
is the raw, unmodified `firmware.bin` — not multipart (esp_http_server has
no multipart parser).
