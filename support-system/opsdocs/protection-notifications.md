# Protection emails

`protection_claim_update` is an editable English template in the existing mail-template editor. It includes the store, order and request references and a **View update** link to `https://us-seel.com/protection`. It does not include the review decision, internal notes or payment information.

For claim updates, only a new transition to `needs_info`, `approved`, `rejected` or `closed` inserts an outbox event. The insert shares the claim update transaction. The unique claim/revision key prevents repeated status requests from creating duplicate work. Editing a note without changing the status does not notify. Initialization does not scan or notify historical claims.

The same delivery worker also handles `protection_shipment_notice` and
`protection_completion_notice`. Snapshot indexing records the first physical
merchandise shipment and the merchant's recorded order completion, once each per
protected order. The shipment template accounts for partial shipments. Completion
means the store marked the order complete, not verified delivery by the carrier.
Fulfilling the protection service alone does not send a shipment message.

A persistent activation timestamp excludes old milestones when historical
snapshots are reindexed. Future events on already-indexed paid, unshipped orders
are eligible. Repeated callbacks and service-fulfillment updates do not create
another event for the same order/stage. Enqueueing and delivery check the order's
current identity and eligibility, including cancellation, removed/refunded
protection, and protection-category email preferences.
If an unsent shipment notice reaches a retry after the order is already complete,
it is cancelled and only the completion notice remains eligible.

## Startup

After `ensureTables()`, await `initProtectionNotificationSchema()` from `src/protection-notification.ts`. Run `processProtectionNotifications({ limit: 10 })` on the background-worker cadence. Its result reports picked, sent, failed, cancelled and disabled counts without message bodies or access credentials.

Delivery defaults to disabled. New status events are still stored while disabled; enabling delivery processes those already-recorded events, not pre-deployment claim history.

## Separate sender configuration

Set `SUPPORT_PROTECTION_MAIL_MODE` explicitly:

- `disabled` (default): no SMTP attempt and no outbox lease.
- `dedicated`: use only the protection sender and credentials listed below. Missing settings do not fall back to ticket mail.
- `shared`: use the existing ticket sender only after explicit authorization for that sender.

Dedicated mode requires `SUPPORT_PROTECTION_SMTP_HOST`, `SUPPORT_PROTECTION_SMTP_PORT`, `SUPPORT_PROTECTION_SMTP_USER`, `SUPPORT_PROTECTION_SMTP_PASS` and `SUPPORT_PROTECTION_MAIL_FROM`. The From address must use `us-seel.com`. Set `SUPPORT_PROTECTION_SMTP_SECURE=true` for implicit TLS (typically port 465); otherwise STARTTLS is required. `SUPPORT_PROTECTION_MAIL_REPLY_TO` is optional and defaults to From.

The selected sender is `Shipping Protection <support@us-seel.com>` on Alibaba DirectMail. This is independent of the ordinary ticket sender. Each protection notification includes the category-specific unsubscribe link, and both enqueue and final SMTP delivery honor the address's `protection` preference across stores; see [email preferences](email-preferences.md). Existing queued/retry events are cancelled when unsubscribed. Shipment, completion and claim-update emails all use this same category.

Verify the new domain/sender with the SMTP provider and publish its required SPF/DKIM/other DNS records before enabling dedicated mode. A working website A record or HTTPS certificate does not configure an email sender. `protectionMailReadiness()` reports configuration readiness only; it does not perform an SMTP send or certify provider/DNS verification.

Production now pins `SUPPORT_PROTECTION_MAIL_MODE=dedicated` in the ignored `docker-compose.override.yml`. On 2026-11-04, the user completed sender configuration and authorized a test. Dedicated credentials are stored only in the private `.env`; the endpoint follows the existing Alibaba configuration (`smtpdm.aliyun.com`, port 465, implicit TLS). SMTP authentication and a test send from `support@us-seel.com` were accepted. The ordinary ticket sender was not reused. Changing `.env` alone does not override an explicit compose value.

Tests use an injected delivery adapter or a fake Nodemailer transport. The first
authorized live test on November 4 used a manually rendered completion template;
automatic shipment and completion triggers were added on November 9. The older
manual test messages are not replayed by activation.

## Retry, privacy and operations

The worker stores rendered snapshots and a dedicated order-bound capability before delivery. Retries reuse the snapshot and Message-ID. Expired/revoked capabilities are regenerated before later attempts. The event recipient must still match the order's current customer email before send; otherwise the event is cancelled. Only token hashes are stored in the access-token table; outbox HTML necessarily contains the private emailed link and must be treated like existing privileged email snapshots.

New manually generated and notification links expire 90 days after issuance. Retry does not extend an existing capability, and previously issued 30-day links keep their original expiration. Sessions last at most 12 hours and never outlive their link; revoking or expiring a link invalidates its sessions. Link validity is independent of the new-request windows: a still-valid link can display an expired request window and existing claim history.

Due rows use a durable lease and a PostgreSQL advisory lock. An active slow worker cannot be duplicated after its lease timestamp expires. Failed preparations or sends retry with exponential backoff, capped at one hour. A crashed worker's lease becomes eligible after five minutes. No state or content is added to ordinary ticket mail jobs.

SMTP acceptance and a database commit cannot be one atomic operation. The worker does not requeue a known-accepted message on later bookkeeping failure, but a crash at that boundary may lead to a repeated delivery after lease recovery. The stable Message-ID helps correlate attempts; it is not a guarantee that every receiving server deduplicates them.

Use a privileged, read-only query for operational counts without exposing links or addresses:

```sql
SELECT status, count(*), min(created_at), max(attempts)
FROM support_protection_notification_outbox
GROUP BY status;
```

For lifecycle diagnostics, group by `event_type,status`. The persistent cutoff is
in `support_protection_notification_activation`; do not reset it during ordinary
restarts or reindexing. If rolling back to an image predating lifecycle support,
disable protection delivery first: an older worker does not distinguish the new
shipment/completion rows from claim-update rows. Keep the outbox and activation
data for a forward repair instead of deleting delivery history.

Validation: isolated PostgreSQL notification/delivery/template suite 12/12; complete repository test command 414 backend passes and 13 environment-dependent skips, frontend 20/20, security checks and TypeScript pass at implementation review. The test database is separate from production.


## Authorized live test (2026-11-04)

The pending notification queue was empty before enabling dedicated delivery. One
completion-template message was accepted by SMTP for the user-designated test
recipient. The test order is `TEST-20261104-QQ-01`, protection reference
`SP-0000000001`, under the synthetic store `protection-mail-test.invalid`. It has
two copied merchandise lines and the source order’s unchanged purchase, shipment
and completion dates. Original contact/address/tracking details and the original
third-party service were excluded; the test service and all platform identifiers
are synthetic. No live store configuration, source snapshot or fulfillment job
was created. The test record remains visible in the protection system for the
user’s manual review workflow and must be distinguished from real business data.

Desktop/mobile browser checks confirmed secure access, both items, and opening
the refund wizard. No claim was submitted by the test operator. Damage/theft
windows are open; delay/loss windows remain based on the copied shipment date.
Subsequent claim status changes use the normal dedicated notification worker.
The one-off mail ledger and its private link are in the ignored
`protection-data/test-runs/20261104-qq-completion-mail.json`; its accepted send
must not be blindly repeated. No passwords or access capabilities belong in Git.

## Mobile email and customer-flow fixes (2026-11-04)

Both protection templates now use a light button fill and dark, underlined text.
The previous completion button kept white text on the link but its only blue fill
was on the parent table cell. Removing that fill reproduced the empty-looking
button reported in QQ mobile mail. The new text remains readable even when all
background fills are removed; both templates also include a plain fallback link.
This is a deterministic sanitization check, not a physical QQ-app certification.

Production current templates and presets were updated only where their bodies
exactly matched the previous defaults (four rows). Subjects and customized bodies
were preserved. The prior rows are backed up privately as
`protection-data/test-runs/20261104-email-buttons-before.json`. Historical sent
snapshots remain unchanged. A separately tracked `[TEST v2]` completion message
uses the same isolated order and designated recipient; its private ledger is
`protection-data/test-runs/20261104-qq-completion-mail-v2.json`.

Customer request-window navigation also now preserves button-label elements when
browser translation replaces text nodes. The original translated Continue label
caused a DOM removal error and unmounted the page when a blocked reason was chosen.
New package-not-received requests require location in both the wizard and API;
received-package location stays optional, and legacy claims remain readable and
supplementable. Location is requested only on an explicit click and sent only
with the final submission; it is supporting evidence, not proof against fraud.

The deployed image is `support-bridge:protection-qq-location-20261104`; prior image
`support-bridge:restored-admin-e54f311` remains available for rollback. Only the
bridge service was replaced. Dedicated sender settings and persistent data remain
in place; the Shoplazza installer is still included in the image.

Validation: standard tests 474 backend passes/16 environment skips plus 24 frontend
passes; isolated PostgreSQL customer/policy tests 24/24; typecheck, production build,
security checks and desktop/mobile browser regressions pass. Live test-order checks
confirmed translated blocked-window navigation, exact UTC dates and required
location without submitting a claim. The browser regressions are reproducible with
`node scripts/test-protection-request-windows.cjs` and
`node scripts/test-protection-customer-location.cjs` from `support-system`, setting
`PLAYWRIGHT_MODULE` and `CHROMIUM_PATH` when installed outside the project.

## Automatic shipment/completion activation (2026-11-09)

Deployed `support-bridge:protection-lifecycle-mail-20261109` with the existing
private-app image target. The persisted activation is
`2026-11-10T02:37:30.157Z` (November 9 in the operator's time zone). The prior image
is `support-bridge:protection-location-guidance-20261108`; observe the rollback
delivery precautions above. Pre-migration notification/template data and the
previous compose override are stored with mode 0600 under the ignored
`protection-data/backups/20261109-lifecycle/` directory.

Both amao04 and hipkastl were checked against their live webhook subscriptions:
payment, full/partial shipment, fulfillment creation/update and order completion
topics are present. The real protected order `OJSGPF62957` was paid and waiting
for shipment at activation. It had no shipment/completion event to send yet, and
its customer had not opted out of protection mail. No customer or synthetic order
status was changed to generate a notification. Existing historical notifications
were preserved and no historical lifecycle messages were queued.

Location now accepts the first valid fresh reading immediately, with an eight
second maximum wait, voluntary retry, and the existing coordinates, reported
accuracy and English permission guidance. The live customer bundle matches the
verified build.

Validation: full standard tests passed (481 backend, 17 environment-dependent
skips; 31 frontend), isolated PostgreSQL lifecycle tests 12/12, existing claim
notification tests 13/13 and protection service tests 10/10. Desktop/mobile
location browser regressions, security checks, TypeScript and production image
build passed. Live health and portal are healthy; unauthenticated order access
remains 401 and staff APIs on the customer domain remain 404. Sender readiness is
dedicated mode, and all three editable protection templates are registered.

## Mobile camera and location permission timing (2026-11-09)

The current production image is `support-bridge:protection-mobile-capture-location-20261109`,
built with the private Shoplazza app target. This customer portal update does
not change notification scheduling, sender settings, templates or the persisted
automatic mail activation time above. Per the operator's request, no new
pre-deployment backup was taken.

Mobile damage photos request the phone camera through HTML capture, followed by
the existing preview, capture session and private upload flow. The browser may
still offer a library choice; the capture session is an audit aid rather than
proof that a photo was newly taken. Desktop retains its in-page camera flow.
Location no longer counts time spent answering the Chrome permission prompt
against its eight-second browser acquisition timeout. A successful permission
grant alone cannot guarantee a position fix. Precise versus approximate access
remains the user's browser/OS choice. Details and historical location behavior
are recorded in `docs/shipping-protection-customer.md`.

Verification: standard tests 481 backend passed and 17 environment-dependent
skipped; 31 frontend passed. TypeScript and production build, private-app Docker
build, isolated desktop/mobile location browser flow, and simulated mobile
camera handoff/preview/upload/cancel flow passed. After deployment the health
endpoint reported 12 stores, customer page returned 200, anonymous order API
returned 401, staff API on the customer domain returned 404, and the live
customer bundle matched the local build hash. No test mail was sent and no real
order state was changed. Physical phone camera and GPS behavior still requires
observation on a real device.

## Damage photo layout and camera guides (2026-11-09)

The current production image is `support-bridge:protection-camera-guides-20261109`,
built with the private Shoplazza app target. The four existing photo categories
now appear in one horizontal row, scrollable on phones. Photo guidelines open on
mouse hover or click/tap. The camera help area has iOS and Android tabs with the
provided permission tutorial images. This update does not change the photo
limits, required damaged-item photo, manual camera exception, notification
schedule, sender or templates. No new pre-deployment backup was taken, as
requested by the operator.

Verification: standard tests passed (481 backend, 17 environment-dependent
skips; 32 frontend), production build, private-app Docker build, Nginx syntax
check and isolated mobile/desktop Chromium camera flow. The live customer page
returned 200. Its JavaScript, CSS and all three new tutorial images matched
the verified local SHA-256 hashes. Unlisted assets and staff routes remained
404 on the customer domain; anonymous order access remained 401. No test mail
was sent and no real order state was changed. Physical phone behavior still
needs observation on a real device.
