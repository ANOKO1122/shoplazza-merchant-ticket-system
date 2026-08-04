#!/bin/sh
set -eu

cp /etc/letsencrypt/live/server.clientservice-center.com/fullchain.pem /etc/nginx/ssl/fullchain.pem
cp /etc/letsencrypt/live/server.clientservice-center.com/privkey.pem /etc/nginx/ssl/privkey.pem

# Certbot shares the Nginx PID namespace; reload only after a successful renewal.
kill -HUP 1
