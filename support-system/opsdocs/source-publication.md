# System publication and local Shoplazza package

The staff system, protection administration, customer portal, email preferences,
and their backend belong to the system release. The Shoplazza storefront/cart,
checkout extension, installer implementation, theme backups and per-store package
manifests remain in local Git under `shipping-protection/`.

## Git boundary

- Publish the system snapshot on `main` to `origin/main`.
- Keep `codex/amao04-shipping-protection` local. It contains the full source and
  application history. Do not push this branch, all branches, or all tags.
- The final product-visibility preview remains on the local
  `codex/amao04-product-visibility` branch. Only its retained public configuration
  endpoint and schema are restored to the system; its retired admin page stays
  removed.
- Do not merge either local application branch into a published branch: removing
  application files from the latest tree does not remove them from its ancestors.
  Transfer reviewed system paths as a snapshot based on the published branch.
- Exclude application-only design plans/specs as well as runtime reports,
  credentials, certificates, evidence, dependencies and generated bundles.

## Builds

The default Docker target builds the system from a system-only checkout:

```sh
docker build -f support-system/Dockerfile -t support-bridge:system .
```

Production also needs the private local Shoplazza package for store component
checks and installation. From the complete local worktree, build explicitly:

```sh
docker build --target with-shoplazza-app -f support-system/Dockerfile -t support-bridge:release .
```

This target includes the local package and its CLI dependencies at
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
