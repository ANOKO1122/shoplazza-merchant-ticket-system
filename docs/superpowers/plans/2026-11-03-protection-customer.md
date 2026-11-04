# Shipping Protection Customer Portal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Deliver the authorized customer refund portal, private evidence, staff review integration, and editable completion email template at us-seel.com.

**Architecture:** Reuse the protection contract and review service with a dedicated customer authentication boundary and DTO. Build an independent React entry and protect the dedicated host with an allowlist; retain staff routes on the original domain.

**Tech Stack:** Existing TypeScript, React, esbuild, Express, PostgreSQL, private filesystem media, nginx and Let's Encrypt.

**Spec:** `docs/superpowers/specs/2026-11-03-protection-customer-design.md`

## Global Constraints

- Customer origin is `https://us-seel.com`; admin stays at `https://server.clientservice-center.com`.
- Refund requests only; no real customer emails, returns, payout calls, or fabricated delivery timestamps.
- One contract supports many claims; quantities and financial allocations are checked server-side.
- Customer DTO excludes internal audit, notes, assignment, and external payout references.
- Location requires customer action and can be skipped; images and videos remain private.

## Review Focus

- Foreign contract IDs/tokens/evidence must not cross an authorization boundary.
- Retry/double-click and concurrent review must not create duplicate or excess claims.
- Denied geolocation, failed uploads, and expired sessions must leave recoverable UI.
- Completion/refund events must not be described as carrier proof of delivery.
- New-host routes must not expose staff pages or redirect secure links to the ticket host.

### Task 1: Customer API and evidence

**Files:** `src/protection-customer-*.ts`, existing protection schema/domain/service/routes/types and tests.
**Interfaces:** `/api/protection/session`, `/order`, `/evidence`, `/claims`, `/claims/:publicNo/messages`; shared `src/protection-customer-types.ts`; `createProtectionAccessLink(orderId)` for staff/email integration.

- [x] Write tests for token isolation, projection privacy, quantity allocations, idempotency, rejected/resubmitted claims, and private media validation.
- [x] Implement scoped token/session, claim quantity/source/public-message schema, customer API, and evidence storage/streaming.
- [x] Run isolated database tests and existing protection service tests.

### Task 2: Customer and review UI

**Files:** `frontend/customer-protection/*`, `public/customer-protection.html`, protection admin order/claim components.
**Interfaces:** Consume shared customer DTO and API; emit `/assets/customer-protection.js` and `.css`.

- [x] Build order/shipments/history page, accessible refund wizard, upload/location/review states, and supplemental messages.
- [x] Add staff evidence/questionnaire/public-message display and secure-link creation.
- [x] Verify desktop/mobile, focus navigation, received/not-received branches, upload failure, and denied location with synthetic data.

### Task 3: Email, application, and domain integration

**Files:** `src/protection-email-template.ts`, `email-service.ts`, `admin-routes.ts`, `pg.ts`, `index.ts`, host-boundary module, build script, email template HTML, nginx/certbot deployment configuration.
**Interfaces:** `protection_completion_notice` template and `protection_link` variable; dedicated public URL config independent of ticket URLs.

- [x] Add template/security tests, seed template idempotently, expose editor tab and previews without enabling sending.
- [x] Wire schema/routes/build and explicit customer-host allowlist.
- [x] Prepare DNS routing/TLS/renewal configuration and verify route isolation with a local nginx fixture; public DNS/TLS activation deferred explicitly by the user.

### Task 4: Integration verification and release

- [x] Run meaningful backend/frontend tests and production build; perform independent code review.
- [x] Exercise synthetic order → secure link → private evidence → claim → staff reply → supplement → rejection → resubmission.
- [x] Build a versioned image, preserve rollback and persistent storage, deploy, and verify both hosts without triggering real emails or claims.
- [x] Document live URLs, template location, operations, and remaining automatic-email/timing decisions.
