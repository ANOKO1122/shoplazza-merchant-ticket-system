# Independent email unsubscribe preferences

Recipients can stop `ticket` or `protection` email independently. A preference belongs to the normalized email address and category, across all stores; it does not close tickets or claims, change an order, or revoke customer access. Address matching trims whitespace and ignores case, but preserves plus tags and dots. No resubscribe or staff preference editor is included in this release.

## Delivery behavior

Every ticket job creator and protection status-event enqueue checks the appropriate preference. Workers check again when preparing old queued jobs and immediately before SMTP. Manual ticket dispatch and retry obey the same check. Ticket jobs become `skipped` with `email_unsubscribed:ticket`; protection outbox jobs become `cancelled` with `email_unsubscribed:protection`. These are policy outcomes, not transport failures. A staff reply is still saved if its notification is suppressed.

A per-address/category PostgreSQL advisory lock serializes explicit unsubscribe confirmation with delivery. A send already in progress finishes before confirmation is saved; mail already accepted by a provider cannot be recalled. After confirmation, later guarded sends are suppressed. Preference-storage failures prevent sending and follow the queue's existing retry behavior. A separate pool of up to four connections holds these locks so SMTP settings queries can still use the ordinary pool.

All current sending paths add an English unsubscribe footer to HTML and plain text. Existing queued snapshots receive the footer when prepared; retries reuse its capability. Future email types, including activation of the draft protection completion template, must use the same category checks and footer decorator. The completion draft is not scheduled by this release.

## Confirmation pages and storage

- Ticket mail links use the effective ticket public domain; protection links use `https://us-seel.com`.
- `GET /email-preferences?token=eu_...` and HEAD only show a masked address and category. Mail scanners opening a link do not unsubscribe.
- The same page posts an explicit confirmation to `/email-preferences`. POST is idempotent, validates the host/category and form origin, and does not accept an arbitrary email or category.
- Native no-referrer forms can send `Origin: null`; this is accepted only with `Sec-Fetch-Site: same-origin`. All other requests use the existing same-origin validation.
- The page requires no login, uses no external assets or scripts, and has no customer-support CTA. It sets no-store, no-referrer, frame restrictions and noindex headers.
- `ensureTables()` creates `support_email_preferences` and `support_email_unsubscribe_tokens` before workers start. The change is additive. Only SHA-256 capability hashes are in the token table; email snapshots necessarily contain their raw unsubscribe URLs and retain their existing privileged access restrictions.
- Tokens authorize only the corresponding unsubscribe, never order access. They intentionally do not expire with the ticket/order link. Preferences and tokens are not removed by job cleanup.
- Nginx allows only this exact additional path on the protection host. Access logs exclude query strings; the preference location suppresses error URL logging. Do not log form bodies, tokens or full URLs in monitoring.

No provider one-click/List-Unsubscribe headers are added; this release uses an explicit confirmation link in the email body.

## Staff visibility and template previews

The staff sidebar's **邮件退订** page is `/thinkpro-admin/email-preferences`. Its authenticated `GET /api/admin/email-preferences` endpoint supports partial email search, independent ticket/protection filters, and pagination (25 rows by default, at most 100). Each email appears once with separate unsubscribe timestamps. Global counts cover all stores; the table total follows its search/filter. The page displays Eastern time, has no reset/delete action, and returns no unsubscribe capabilities or hashes. The customer domain does not expose this page or API.

The email footer link and confirmation button now read exactly `Unsubscribe`. The confirmation heading and explanation still identify the category. Preparing an old queued message replaces its system footer while preserving a valid bound token. Existing delivered messages retain their original content and valid links.

The template editor and its preview endpoint now render the same system footer. It is automatically appended rather than saved into editable template text. Previews use an inactive `?preview=1` link on the category's domain; they never generate recipient tokens or alter preferences. Rapid edits and template changes ignore stale preview responses. Actual email jobs still receive recipient-bound links during preparation.

## Sender configuration

The protection sender is `Shipping Protection <support@us-seel.com>` using Alibaba DirectMail. On 2026-11-04, the user supplied the dedicated credentials, SMTP authentication succeeded, and production switched to `SUPPORT_PROTECTION_MAIL_MODE=dedicated`. One explicitly authorized test email was accepted. The explicit compose override wins over `.env`; credentials remain in private configuration. Do not switch to the original ticket sender. The completion template is still sent manually for this test; automatic completion scheduling remains unimplemented. See [notification operations](protection-notifications.md#authorized-live-test-2026-11-04).

Publish the DNS values provided by the Alibaba console for the selected region, create the sender and set its SMTP password. Save credentials in private server configuration, never source or chat. A DirectMail sender does not itself provide a receiving mailbox; configure Reply-To only when a real mailbox is available. See [Alibaba sender setup](https://www.alibabacloud.com/help/en/direct-mail/user-guide/setup-sender-addresses) and [domain configuration](https://www.alibabacloud.com/help/en/direct-mail/getting-started/simplified-procedure-of-configuring-email-delivery).

## Operations and validation

Counts can be inspected without disclosing recipients or capabilities:

```sql
SELECT category, count(*) FROM support_email_preferences GROUP BY category;
SELECT category, count(*) FROM support_email_unsubscribe_tokens GROUP BY category;
SELECT status, count(*) FROM support_email_jobs
WHERE last_error = 'email_unsubscribed:ticket' GROUP BY status;
SELECT status, count(*) FROM support_protection_notification_outbox
WHERE last_error = 'email_unsubscribed:protection' GROUP BY status;
```

Validation on 2026-11-04: complete repository command passed (447 backend passes, 14 environment-dependent skips; frontend 24/24 and security checks). Explicit isolated-database checks passed: shared preferences 9/9, protection notifications 13/13, customer flow 17/17, staff lifecycle 10/10, and protection mailer 2/2. Ticket creation/delivery/admin suites passed 98 checks. The public router/host suite passed 12 checks; desktop and mobile browser checks verified confirmation, category separation and no overflow. No real test emails were sent.

Before deployment back up the current compose override and nginx config. Apply the additive schema via normal startup, preserve disabled protection delivery, reload only validated nginx configuration, and recreate only support-bridge. Check both public preference routes, the protection customer page and the staff login. Do not roll back to a sender image that ignores preferences after any recipient has unsubscribed; first pause outbound workers or use a compatible patched image. Never drop preference tables during rollback.

Deployed image: `support-bridge:email-preferences-20261104`, manifest `sha256:3ea400f175ea41e25db5e31a0f579da1293989a26ae527ae4786190355b2ecc1`. Production nginx and compose backups: `/tmp/email-preferences-deploy-20261104`. Verified both domains return the controlled confirmation error for missing tokens, reject malformed JSON with 415 before the global parser, and retain customer/staff route isolation. Customer entry/assets and staff login remain available. Dedicated protection credentials are still incomplete and delivery remains disabled.

Staff visibility follow-up deployed as `support-bridge:email-preferences-admin-20261104`, manifest `sha256:92a128c505b4b56d8c22ee3a76c7b1a4324b63cf267506b4ca335b334ce95b12`; compose backup `/tmp/email-preferences-admin-deploy-20261104`. Final checks: 459 backend passes and 15 environment-dependent skips; frontend 24/24; security/redirect checks; isolated listing/auth 4/4, shared preferences 10/10, notification worker 13/13. Synthetic desktop/mobile and actual template-preview integration checks passed. Production API/page authentication, customer-host isolation, public confirmation pages, canonical login, and read-only listing/preview smoke checks passed. Protection mail remains disabled; no real test emails were sent.
