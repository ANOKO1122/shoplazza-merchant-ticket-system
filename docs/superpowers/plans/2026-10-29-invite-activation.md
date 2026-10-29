# Invitation Activation Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement the approved change and request an independent final review.

**Goal:** Extend an invitation exactly once upon successful ticket creation and keep its original email link attached to that ticket.

**Architecture:** Reuse existing bootstrap_token_hash associations. Serialize creation on the invitation row and make token, ticket, messages, and expiry writes atomic. Both bootstrap and submission routes resolve an already activated invitation before the order fallback.

**Tech Stack:** TypeScript, Express, PostgreSQL, node:test.

**Spec:** docs/superpowers/specs/2026-10-29-invite-activation-design.md

## Global Constraints

- Keep existing configured expiry days and ticket-access issuance behavior.
- No bulk renewal of historical invitations, email sends, schema changes, or customer-page redesign.
- Main, author ANOKO1122, push and deploy; exclude unrelated support-system/tmp files.

## Review Focus

- Same order with multiple tickets or a closed original must resolve the original invitation's ticket.
- Duplicate and concurrent submissions must not create another ticket or extend the invitation again.
- A failed message/token/ticket write must leave neither partial data nor an extended invitation.
- Expired, revoked, or mismatched invitation credentials must fail without writes.
- Ordinary visits, reply notifications and new invitations must leave the original invitation expiry unchanged.

## Task 1: Atomic activation and exact invitation routing

**Files:** Modify support-system/src/token.ts, ticket-service.ts, support-routes.ts. Add support-system/src/invite-activation-db.test.ts.

**Interfaces:** Preserve createTicket input/output. Add optional PoolClient to createTicketAccessToken and internal token storage; default callers use the current pool. findTicketByBootstrapTokenHash accepts an optional PoolClient for a transaction-local lookup.

- [x] Write integration tests in a guarded empty local database for both invitation types, exact expiry equality, visits, replies/new invites, duplicate/concurrent submissions, closed/multiple tickets, invalid credentials, and rollback.
- [x] Run the integration tests and confirm missing behavior fails before implementation.
- [x] Implement transactional creation, row locking, exact expiry copy and bound-ticket precedence in both routes.
- [x] Rerun the integration tests, npm run build and npm test; address failures and request independent review.
- [x] Commit reviewed files as ANOKO1122; push main. Build the tracked source only, deploy support-bridge and verify health and deployed file hashes.

## Execution record

- User approved the exact activation-only rule in conversation; no additional design or deployment approval is needed.
- Initial review confirmed the order fallback can select another ticket and existing creation writes are not transactional.

- Verified RED: expiry mismatch, wrong closed-ticket destination, duplicate creation, and partial-write retention before implementation.
- Independent review identified a route-level activation race; a real PostgreSQL HTTP test reproduced 409 before the fix, then passed with the conflict-branch binding recheck.
- Final validation: TypeScript build passed; full suite 397 passed, 6 unrelated opt-in tests skipped, 0 failed; frontend security checks passed. All 11 invitation scenarios passed against disposable PostgreSQL. Final independent review found no remaining blockers.
- Deployed implementation commit 8d3ae5f from tracked source only. Public health passed for 12 stores; running source, compiled modules, and the previously restored store page match the reviewed workspace. Invalid invitation smoke request returned HTTP 401. No historical invitation renewal was run.
