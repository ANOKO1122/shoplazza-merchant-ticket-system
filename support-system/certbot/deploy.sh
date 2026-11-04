#!/bin/sh
set -eu

lineage=${RENEWED_LINEAGE:-/etc/letsencrypt/live/server.clientservice-center.com}
case "$lineage" in
  /etc/letsencrypt/live/server.clientservice-center.com)
    certificate_destination=/etc/nginx/ssl
    ;;
  /etc/letsencrypt/live/us-seel.com)
    certificate_destination=/etc/nginx/ssl/us-seel.com
    ;;
  *)
    echo "Unrecognized certificate lineage; refusing deployment." >&2
    exit 1
    ;;
esac

mkdir -p "$certificate_destination"
cp "$lineage/fullchain.pem" "$certificate_destination/fullchain.pem.next"
cp "$lineage/privkey.pem" "$certificate_destination/privkey.pem.next"
chmod 600 "$certificate_destination/privkey.pem.next"
mv "$certificate_destination/fullchain.pem.next" "$certificate_destination/fullchain.pem"
mv "$certificate_destination/privkey.pem.next" "$certificate_destination/privkey.pem"

# Certbot shares the Nginx PID namespace; reload only after a successful renewal.
kill -HUP 1
