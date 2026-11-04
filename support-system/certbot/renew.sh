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
  # Only renew the customer certificate after its initial successful issuance.
  # Its own lineage/deploy destination keeps the staff certificate independent.
  if [ -f /etc/letsencrypt/renewal/us-seel.com.conf ]; then
    certbot renew \
      --cert-name us-seel.com \
      --non-interactive \
      --deploy-hook /opt/deploy.sh
  fi
  sleep 12h & wait $!
done
