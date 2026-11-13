FROM node:24-alpine AS system
WORKDIR /app
RUN apk add --no-cache python3 make g++ ffmpeg
COPY support-system/package.json support-system/package-lock.json ./
RUN npm ci
COPY support-system/ .
ENV SUPPORT_PROTECTION_PACKAGE_DIR=/opt/shipping-protection
ENV SUPPORT_PROTECTION_DATA_DIR=/app/protection-data
RUN if [ -f src/index.ts ]; then npm run build; fi && npm prune --omit=dev
EXPOSE 4001
CMD ["node", "dist/index.js"]

# Explicit deployment target; the app package comes from its separate Git checkout.
FROM system AS with-shoplazza-app
COPY --from=protection_source / /opt/shipping-protection/
RUN cd /opt/shipping-protection && npm ci && ln -s /opt/shipping-protection /shipping-protection

# BuildKit skips the unused app stage for the default, standalone system image.
FROM system AS runtime
