# Protection Claim Update Notifications Implementation Plan

**Goal:** Send an editable, generic English request-update email for new transitions to needs_info, approved, rejected or closed, with a private us-seel.com link.

**Architecture:** A separate PostgreSQL outbox is inserted in the existing claim update transaction and deduplicated by claim/revision. A bounded worker leases due entries, snapshots the rendered message and a customer capability, and retries failures. It reuses the existing template renderer and mail service while keeping protection delivery configuration separate from ticket mail.

**Tech Stack:** Existing TypeScript, PostgreSQL, Express template administration and Nodemailer; no dependency additions.

**Authorization and scope:** Root supplied this implementation scope and approved the API. No real emails during implementation. No historical scan, ordinary ticket jobs, payment decision details, or new completion-email activation. The existing completion template remains an editable draft.

## Interfaces and ownership

- New `src/protection-notification.ts`: `enqueueProtectionClaimUpdate(client,{claimId,revision,previousStatus,status})`, `processProtectionNotifications({limit})`, and schema/template initialization.
- New `src/protection-notification-schema.ts`: additive outbox DDL.
- New `src/protection-notification-mailer.ts`: disabled/shared/dedicated delivery modes. Default is disabled; shared sender requires explicit configuration. Dedicated settings use `SUPPORT_PROTECTION_SMTP_*` and `SUPPORT_PROTECTION_MAIL_FROM/REPLY_TO`.
- Existing protection email template module, renderer defaults, template admin routes and template editor gain `protection_claim_update`.
- Backend agent owns the same-transaction status hook. Root owns startup/schema/worker wiring, activation and deployment.

## Implementation and verification

- [x] Write failing tests for generic editable output, disabled delivery, isolated recipient capability, transactional rollback, event deduplication, concurrent workers, durable retries, stale lease recovery and changed-recipient cancellation.
- [x] Add outbox schema, transactional enqueue, message preparation and worker. Keep SMTP acceptance separate from post-send bookkeeping to avoid retrying known accepted messages on logging failures.
- [x] Add protected delivery adapter and stable Message-ID support. SMTP acceptance followed by process loss cannot offer strict exactly-once delivery; do not claim otherwise.
- [x] Register template/default/preview/preset through existing template tools without replacing saved templates.
- [x] Run isolated PostgreSQL tests with a fake delivery adapter; run template, frontend-security, TypeScript and relevant full regression checks.
- [x] Report configuration and startup API to root, with no production mail activation.

## Review focus

- Updating notes or retrying the same revision must not send another status notification.
- A rolled-back status change must not create a notification.
- Multiple workers and stale leases must not send concurrently for the same event.
- A customer email change must not let the old recipient access the current order.
- Disabled or incomplete dedicated configuration must never silently use ordinary ticket SMTP.

Read-only configuration inspection found an existing working ticket sender on server.clientservice-center.com. That is not authorization to use it for protection mail. The user explicitly chose to wait for the new domain's separate sender. Production keeps SUPPORT_PROTECTION_MAIL_MODE=disabled; website activation is independent.
