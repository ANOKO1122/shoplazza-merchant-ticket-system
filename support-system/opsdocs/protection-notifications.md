# Protection request update emails

`protection_claim_update` is an editable English template in the existing mail-template editor. It includes the store, order and request references and a **View update** link to `https://us-seel.com/protection`. It does not include the review decision, internal notes or payment information.

Only a new transition to `needs_info`, `approved`, `rejected` or `closed` inserts an outbox event. The insert shares the claim update transaction. The unique claim/revision key prevents repeated status requests from creating duplicate work. Editing a note without changing the status does not notify. Initialization does not scan or notify historical claims. Completion notices remain an editable draft and are not activated by this worker.

## Startup

After `ensureTables()`, await `initProtectionNotificationSchema()` from `src/protection-notification.ts`. Run `processProtectionNotifications({ limit: 10 })` on the background-worker cadence. Its result reports picked, sent, failed, cancelled and disabled counts without message bodies or access credentials.

Delivery defaults to disabled. New status events are still stored while disabled; enabling delivery processes those already-recorded events, not pre-deployment claim history.

## Separate sender configuration

Set `SUPPORT_PROTECTION_MAIL_MODE` explicitly:

- `disabled` (default): no SMTP attempt and no outbox lease.
- `dedicated`: use only the protection sender and credentials listed below. Missing settings do not fall back to ticket mail.
- `shared`: use the existing ticket sender only after explicit authorization for that sender.

Dedicated mode requires `SUPPORT_PROTECTION_SMTP_HOST`, `SUPPORT_PROTECTION_SMTP_PORT`, `SUPPORT_PROTECTION_SMTP_USER`, `SUPPORT_PROTECTION_SMTP_PASS` and `SUPPORT_PROTECTION_MAIL_FROM`. The From address must use `us-seel.com`. Set `SUPPORT_PROTECTION_SMTP_SECURE=true` for implicit TLS (typically port 465); otherwise STARTTLS is required. `SUPPORT_PROTECTION_MAIL_REPLY_TO` is optional and defaults to From.

The selected sender is `Shipping Protection <support@us-seel.com>` on Alibaba DirectMail. This is independent of the ordinary ticket sender. Each protection notification includes the category-specific unsubscribe link, and both enqueue and final SMTP delivery honor the address's `protection` preference across stores; see [email preferences](email-preferences.md). Existing queued/retry events are cancelled when unsubscribed. The completion draft must use this same category when its delivery trigger is implemented.

Verify the new domain/sender with the SMTP provider and publish its required SPF/DKIM/other DNS records before enabling dedicated mode. A working website A record or HTTPS certificate does not configure an email sender. `protectionMailReadiness()` reports configuration readiness only; it does not perform an SMTP send or certify provider/DNS verification.

Production explicitly pins `SUPPORT_PROTECTION_MAIL_MODE=disabled` in `docker-compose.override.yml`. Changing `.env` alone will not override that value. When the dedicated sender is ready, update that explicit setting, validate compose, and recreate only support-bridge. The user chose to wait; shared delivery is not authorized.

No real mail was sent during implementation. Tests use an injected delivery adapter or a fake Nodemailer transport.

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

Validation: isolated PostgreSQL notification/delivery/template suite 12/12; complete repository test command 414 backend passes and 13 environment-dependent skips, frontend 20/20, security checks and TypeScript pass at implementation review. The test database is separate from production.
