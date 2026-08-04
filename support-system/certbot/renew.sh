#!/bin/sh
set -eu

while :; do
  certbot certonly \
    --webroot -w /var/www/certbot \
    -d server.clientservice-center.com \
    --cert-name server.clientservice-center.com \
    --non-interactive \
    --agree-tos \
    --register-unsafely-without-email \
    --keep-until-expiring \
    --deploy-hook /opt/deploy.sh
  sleep 12h & wait $!
done
