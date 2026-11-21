#!/bin/sh
set -eu
cd -- "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
cert=${SHARESERIAL_CERT:-certs/cert.pem}
key=${SHARESERIAL_KEY:-certs/key.pem}
if [ ! -f "$cert" ] || [ ! -f "$key" ]; then
    echo 'Configure SHARESERIAL_CERT and SHARESERIAL_KEY with your HTTPS certificate and private key. See README.txt.' >&2
    exit 1
fi
exec ./shareserial -addr "${SHARESERIAL_ADDR:-127.0.0.1:12345}" -cert "$cert" -key "$key" "$@"
