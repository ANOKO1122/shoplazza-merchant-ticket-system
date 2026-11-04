# Independent email unsubscribe preferences

**Goal:** Let a recipient stop all ticket email or all shipping-protection email independently, across stores, without closing tickets/claims or disabling portal access.

**Confirmed scope:** The user chose Alibaba DirectMail and `support@us-seel.com` for protection mail. Dedicated sending remains disabled until its domain and SMTP credentials are ready. Existing ticket delivery continues subject to each recipient's preferences.

**Architecture:** PostgreSQL stores preferences keyed by normalized email plus `ticket`/`protection`. Opaque email links identify exactly one category and recipient. GET displays an English confirmation; explicit POST records an idempotent unsubscribe. Both queues check at creation and again immediately before delivery. Per-recipient/category advisory locks serialize confirmed unsubscribes with an already-started SMTP attempt. No resubscribe/admin preference panel or bulk historical emailing is added.

**Tech stack:** Existing TypeScript/Express/PostgreSQL/Nodemailer service; small server-rendered accessible confirmation page.

## Work and interfaces

- [x] Shared schema and core (`src/email-preferences{-schema,}.ts`, tests): email normalization retains plus tags and dots; hashed random tokens; category binding; preference lookup/upsert; guarded delivery; reusable English footer link and text alternative. `isEmailUnsubscribed(email, category, db?)`, `withEmailPreferenceGuard(email, category, callback)`, `decorateEmailWithUnsubscribe(mail, category, baseUrl, db?)`.
- [x] Ticket queue: all creation paths, pending jobs, manual dispatch and resend honor category `ticket`. Suppressed jobs are skipped with a visible reason, never counted as sent or transport failures. Existing order-level suppression remains.
- [x] Protection queue: transactionally skip enqueue; cancel queued/retry mail on unsubscribe. Preserve body snapshots and recipient checks. Category `protection` includes the generic updates and future completion notices.
- [x] Public pages/routes: `/email-preferences?token=...` GET confirmation and POST explicit unsubscribe; host/category restrictions, no-store/no-referrer, token-safe logs, no login or customer-support entry. Only this exact extra path is allowed on the protection host.
- [x] Initialize additive schema before workers, retain disabled protection SMTP, set chosen sender name/address, deploy reviewed image and exact nginx routes; verify both domains and original staff routes.

## Review and validation

Test category separation across stores and normalized addresses; forged tokens and altered category inputs; GET scanner safety and repeated POST; unsubscribe after enqueue and before manual resend; failure of preference storage fails closed; concurrent unsubscribe/send serialization; footer idempotence and opaque links on correct domains; existing ordinary suppression and protection delivery retry behavior. Use isolated PostgreSQL/fake transports, never real customer mail. Check the English page once at desktop/mobile sizes. Run repository tests, build and production route/bundle/config checks before completion.

## Sender setup

The user must verify `us-seel.com` in their Alibaba console and set a dedicated SMTP password for `support@us-seel.com`. DNS record values depend on the selected region/domain and must come from that console. Credentials go in the server's private environment, not source or chat. A working customer website does not imply SMTP readiness. Test recipient remains to be supplied.

## Deployment result

Deployed `support-bridge:email-preferences-20261104` on 2026-11-04. Final repository checks: 447 backend passes, 14 environment-dependent skips, 24 frontend passes; shared preference and protection outbox isolated database checks passed separately. Both domain confirmation routes, malformed-body rejection, customer assets, staff login and customer/staff isolation were verified live. Protection mail remains disabled with the selected `support@us-seel.com` sender; dedicated SMTP settings and a test recipient are still pending. No real test mail was sent.
