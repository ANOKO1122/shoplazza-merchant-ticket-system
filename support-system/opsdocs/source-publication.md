# System publication and local Shoplazza package

The staff system, protection administration, customer portal, email preferences,
and their backend belong to the system release. The Shoplazza storefront/cart,
checkout extension, installer implementation and per-store manifests live in a
separate local Git repository at `/root/work/shipping-protection`. Theme backups,
build outputs and store credentials stay outside Git.

## Git boundary

- Publish reviewed system changes to the configured system remote. The current
  author's Git identity is `ANOKO1122 <1203364600@qq.com>`; the `anoko` remote
  points to the ANOKO1122 repository.
- Commit storefront and installer changes only in the separate
  `/root/work/shipping-protection` repository. Keep its future GitHub repository
  private because store manifests contain platform identifiers.
- Do not commit runtime reports, credentials, certificates, theme backups,
  dependencies or generated bundles to either repository.

## Builds

The default Docker target builds the system from a system-only checkout:

```sh
docker build -f support-system/Dockerfile -t support-bridge:system .
```

Production also needs the private local Shoplazza package for store component
checks and installation. Build with its separate checkout as a named context:

```sh
docker build --target with-shoplazza-app \
  --build-context protection_source=/root/work/shipping-protection \
  -f support-system/Dockerfile -t support-bridge:release .
```

For Compose deployment, set the ignored `support-system/docker-compose.override.yml`
service build target to `with-shoplazza-app` and add
`build.additional_contexts.protection_source: /root/work/shipping-protection`.
The target includes the separate package and its CLI dependencies at
`/opt/shipping-protection`, retaining the installer environment and writable
per-store data directory. Building this local image does not publish its source.
Do not replace the production image with the system-only target when store
installation and checks are required. The generated customer portal no longer
imports files from the local application package.

Production credentials and image selection remain in the ignored `.env` and
`docker-compose.override.yml`. Keep the dedicated protection email sender
disabled until its configuration is complete. Preserve the existing data volumes
and customer-domain nginx block when applying a system source snapshot.

## Navigation restoration (2026-11-04)

Older pages supplied static sidebars missing the protection link. The shared shell
now restores every missing master navigation entry while keeping custom links and
targets. The module is **运输保障 → 赔付审核**. Sidebar reconciliation is covered
by regression tests and direct/SPA/back-forward browser checks.

Verification before publication: 468 backend tests passed (16 environment-dependent
skips), 24 frontend tests passed, 39 local Shoplazza package tests passed, and
6 restored-rule tests passed against an isolated database. Browser checks covered
8 direct admin pages, 7 SPA destinations, back/forward navigation, and the actual
claims module. A default Docker build from a directory without the local app
succeeded and contained the compiled system assets. No live customer mail or
store component changes were used for these checks.
