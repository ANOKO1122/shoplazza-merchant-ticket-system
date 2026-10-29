# Webhook and Logistics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task. User has directly authorized implementation; no further approval gate.

**Goal:** Receive authenticated webhook bursts without quota rejection and reconcile relevant logistics in batches with independent store budgets.

**Architecture:** Preserve durable webhook workers and the fulfillment merger. Replace ingress quota with authentication only; select recent paid orders and active ticket orders using SQL, fetch per-store ID batches, and retain audit evidence.

**Tech Stack:** TypeScript, Express, PostgreSQL 16, Shoplazza 2025-06 API, Node test runner.

**Spec:** `docs/superpowers/specs/2026-10-29-webhook-logistics-design.md`

## Global Constraints

- main, ANOKO1122 author, push and deploy; no PR or backup.
- No historical notification emails, no data exports with secrets.
- Preserve unrelated admin-stores.html and tmp changes.
- Hourly schedule, 1,000 orders per enabled store, batches of 50 IDs.
- Normal orders: upstream order age <=30 days, successful recheck 24 hours. Active ticket exceptions: activity <=30 days, successful recheck 6 hours. Failure retry 1 hour.

## Review Focus

- Provider ignores ids or omits one requested order: must not apply unrelated data or claim missing data is empty.
- Multi-page, multi-package data and late/current tracking numbers: preserve complete results and previous numbers.
- Old orders with recent local insert/view timestamps: must not re-enter normal scanning.
- Ticket activity, duplicate snapshots and same order IDs across stores: no stale priority or cross-store updates.
- Partial upstream failure or concurrent worker: release locks, keep successful check time, preserve future retry.

### Task 1: Webhook ingress and evidence

Files: api-rate-limits.ts/test, webhook-security.ts/test, index.ts comment.

- [x] Test >600 valid same-store requests accepted, invalid auth rejected, admin quota unchanged; run RED.
- [x] Remove only webhook quota; persist redacted rejection metadata asynchronously without delaying responses.
- [x] Verify rejection logging excludes secrets and bodies, and logging failure does not affect responses; run focused tests.

### Task 2: Batch fulfillment API

Files: shoplazza-client.ts, new shoplazza-batch-fulfillments.test.ts.

Interface: `listOrderFulfillmentsBatch(store: ShoplazzaStoreConfig, orderIds: string[]): Promise<Map<string, Record<string, unknown>[]>>`, max 50 unique nonempty IDs. Missing requested IDs remain absent from Map; caller records failure. No mutations.

- [x] Read-only live verify repeated ids filter and compare list fulfillments with per-order endpoint.
- [x] Test IDs, pagination, empty fulfillments, missing IDs, unexpected IDs, duplicates/conflicts, malformed data, timeouts and HTTP errors; run RED.
- [x] Implement strict batched GET and run focused tests.

### Task 3: Candidate selection and reconciliation

Files: fulfillment-reconcile.ts/test, new selection SQL module and DB integration test, index.ts schedule call, integration script if needed.

- [x] Test actual candidate SQL in isolated DB: recent vs old, active vs stale tickets, viewer updates, multi-store budgets, duplicate snapshots and due ordering; run RED.
- [x] Test batch orchestration: >200 across each store, per-order incomplete responses, priority interval, lock release, history-preserving merger use, metrics; run RED.
- [x] Implement per-store selection and batches of 50; keep manual single-order path and existing failure handling.
- [x] Add summary counts for priority and normal checks, API batches and selected limits; update hourly call to use default per-store quota.

### Task 4: Verification and delivery

- [x] Run focused tests, full npm test, tsc and isolated DB integration checks; inspect production candidate query read-only.
- [x] Fresh independent code review; fix material findings with regression tests.
- [ ] Commit only task files as ANOKO1122, push main, build from committed clean files and deploy support-bridge only.
- [ ] Verify public health, deployed hashes, live queue/receipt evidence, and one no-email logistics batch.
- [ ] Report commit, deployed behavior and remaining observational limits. Do not claim future coverage before remeasurement.


## Verification evidence (2026-10-29, before deployment)

- Full npm test with actual selection SQL on an isolated PostgreSQL 16 database: 392 tests, 387 passed, 5 unrelated opt-in checks skipped, 0 failed; offline frontend security checks passed.
- TypeScript production build passed; git diff whitespace check passed.
- Separate PostgreSQL integration script passed concurrency/history accumulation, atomic rollback, durable webhook retry, paid invitation idempotency, batch selection/missing-result handling and historical email isolation. No external SMTP/API calls in these integration checks.
- Read-only production candidate selection completed in approximately 3.5 seconds; remaining-due query in approximately 2.8 seconds.
- Live read-only Shoplazza comparison verified the repeated ids filter, multiple packages, identical logistics fields and paginated terminal response. No remote orders were modified.
- Independent review found no material issues; 82 focused tests passed.
