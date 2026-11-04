# Shipping Protection Admin Implementation Plan

> **For agentic workers:** Use subagent-driven-development for independent backend and frontend tasks; root owns installation integration and whole-system validation.

**Goal:** Deliver integrated statistics, protected orders, claims review and store installation/health management.

**Architecture:** Authenticated Express routes, PostgreSQL state and audit; independent React/TS admin bundle sharing existing shell. Reuse the committed shipping installer with validated configuration and persistent jobs, never shell-interpolated commands.

**Tech Stack:** TypeScript, React, esbuild, Express, PostgreSQL.

**Spec:** ../specs/2026-11-03-protection-admin-design.md

## Constraints

No payment execution, customer email, portal or unconfirmed coverage rules. Preserve both live stores and existing ticket flows. All new state is additive. No credentials or screenshot customer data in fixtures.

## Review focus

Duplicate order snapshots; mixed currencies/refunds; parallel claims decisions; stale theme/install observations; old shell external-script navigation.

## Tasks

- [x] Data/backend: `src/protection-{types,schema,service,routes}.ts`, pure domain and PostgreSQL tests. Shared contracts, stable protection IDs with multiple claim IDs, transactional review/audit/revisions and per-item approved balances. Bounded history indexing plus transactional dirty queue handles out-of-order commits; unknown money remains unknown and unverified refund details block new approvals.
- [x] Installation: `src/protection-store-{schema,service}.ts`, `src/protection-installer.ts`; seed two manifests, authenticated remote checks, persistent serialized jobs and admin-only actions. Reuse deployment code, backups, exact-theme preflight and 14/15/20-minute deadline/recovery handling.
- [x] UI: `frontend/protection/`, compiled `public/protection/`, `public/admin-protection.html`; four tabs, filters/pagination, order/claim detail, internal registration/review/assignment, external completion records and store health/actions. Match API contracts and render unknown/empty/error states explicitly.
- [x] Integration: `src/pg.ts`, `src/index.ts`, `src/admin-pages.ts`, `public/admin-shell.js`, Docker packaging and build. Full-page boundary for React preserves existing soft navigation; additive schemas and background-job guard are wired.
- [x] Fulfillment readiness: official partial-line create/complete semantics verified and current service fulfillment status displayed. Automatic writes remain disabled pending verification of Shoplazza notification behavior on fulfillment creation; no whole-order completion or customer email triggered.
- [x] Automated verification/review: production build, backend 405 tests (396 passed / 9 database-dependent skips), frontend 6 passed, shipping package 36 passed; independent targeted backend/domain/installer 20 passed and earlier HTTP/store 4 passed. Operational scope and limitations documented in `docs/shipping-protection-admin.md`.
- [x] Final browser E2E: desktop/mobile and old/new navigation passed without JavaScript errors or page overflow. Full create/reject/new-issue/409-preserve-draft/approve/external-close flow passed using isolated synthetic data. Tab navigation resets scroll. Both live storefront read-only probes passed.
- [x] Deployment: pinned image released using documented Compose override; public authenticated page/assets/API and same-origin guards verified. Both production check jobs succeeded with existing components still enabled, no live reinstall/disable or claim decisions. Automatic fulfillment remains off.
