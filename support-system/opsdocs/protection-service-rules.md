# Shipping protection request rules — deployed 2026-11-04 UTC

## Live configuration

- Customer site: https://us-seel.com, independent TLS and public-route allowlist.
- Image: `support-bridge:protection-rules-20261104-r2`.
- Manifest-list digest: `sha256:88e0385e007c8640370ffe34c3ed12dfdddc092af1bb6054238ac639926f5720`.
- Immediate rollback image: `support-bridge:protection-rules-20261104`; pre-feature image is retained as `support-bridge:pre-protection-rules-20261104`.
- Runtime: `SUPPORT_PROTECTION_POLICY_BASIS=shipment`, `SUPPORT_PROTECTION_FULFILLMENT_ENABLED=true`, `SUPPORT_PROTECTION_MAIL_MODE=disabled`.
- Both pilot stores use `policyBasis: shipment` in their persisted manifest. Amao04 checkout extension is 1.8; hipkastl is 1.2.
- First activation for both pilot stores: 2026-11-04T03:48:54.611Z. Only proven completion dates on/after each store's activation are eligible for automatic service fulfillment. No historical completed-order sweep.

## Confirmed rules

| Issue | Opens | Last new-request time |
| --- | --- | --- |
| Delay | Selected merchandise shipment +30 days | Order creation +90 days |
| Loss / missing items | Selected merchandise shipment +60 days | Order creation +90 days |
| Damage | Recorded order completion | Recorded order completion +7 days |
| Theft | Recorded order completion | Recorded order completion +7 days |

Times use elapsed UTC days, displayed with date/time and UTC in the customer portal. A selection spanning shipments uses the latest relevant recorded shipment; ambiguous or missing quantity/date mapping requires verification. A store completion status is not a carrier-confirmed delivery scan. Missing completion times are never inferred from today's date or arbitrary later order updates.

The server checks new customer and staff-created requests. Submission saves the applicable rule evidence; timely existing requests can continue review and supplementary evidence after their new-request deadline. Refund/cancellation, overlapping active requests and remaining merchandise value are checked separately. Legacy non-covered request categories remain readable but cannot be approved under these rules.

## Customer information and mail

Cart, checkout and customer pages share English service descriptions and timing copy. The information control supports hover, focus, pinned click/tap, Escape and outside dismissal; tall content scrolls internally without changing the protection card height or purchase selection.

Customer links remain usable independently of request eligibility. Selecting an expired issue shows an English explanation with the affected item's request dates and UTC deadline, with Back/Close actions only. There is no customer-support entry or referral. Mixed item windows permit selection of still-eligible items; existing requests and supplements remain accessible. New links last 90 days; prior links and the 12-hour session limit are unchanged.

`protection_claim_update` is the generic editable notification for needs_info/approved/rejected/externally handled transitions. As of 2026-11-10, saving a claim no longer queues this email. Staff must use the explicit send action in the claim detail; the dedicated us-seel.com sender is configured. Shipment and completion notices remain automatic. See `protection-notifications.md` for the current delivery rules. Earlier deployment notes below describe historical stages and should not be used as current operating instructions.

## Service fulfillment

Both pilots have verified read_order and write_order scopes. The worker reads the authoritative order and all fulfillment memberships before writing. It requires paid, finished, uncancelled orders and only configured protection product IDs. Mixed physical/service packages require manual handling. It never marks physical lines complete.

Create uncertainty is persisted before the provider request; reconciliation will not create again blindly. Temporarily stale reads retry, with a bounded retry count before a job becomes blocked. Completion is verified by a final authoritative read. Our ordinary logistics callbacks are data-only and do not enqueue ticket mail; native Shoplazza notification settings were absent in read responses, so their behavior is not independently verified.

No finished protected real order was available at deployment. Therefore the first real service-completion attempt still needs observation for provider acceptance; all mutation scenarios so far used an isolated fake provider.

Read-only operational checks (no tokens, addresses or message bodies):

```sql
SELECT status, count(*), max(attempts)
FROM support_protection_fulfillment_jobs GROUP BY status;
SELECT id, status, attempts, message, updated_at
FROM support_protection_fulfillment_jobs WHERE status = 'blocked' ORDER BY id DESC;
SELECT status, count(*) FROM support_protection_notification_outbox GROUP BY status;
```

## Verification and rollback

- Full repository: 431 backend tests, 418 pass / 13 environment-dependent skips; frontend 20/20; frontend security checks pass.
- Explicit isolated suites fill the relevant integration gaps: customer/API 18/18, staff/domain 18/18, durable fulfillment 9/9, notification/template/delivery 12/12. Separate review of fulfillment/policy/status code: 38/38.
- Store package: 39/39; both extension builds and installs succeeded.
- Live read-only checks confirm both release versions, compiled asset fingerprints and one managed cart script per theme. Amao04 published-theme preview verified the information control, fixed footer and fee update $2.00 → $2.85. Direct custom-domain browser access met Cloudflare; later ordinary cart requests failed with Chromium `ERR_NETWORK_CHANGED`, so the full checkout browser path was not yet established by that run. No payment was submitted.
- Hipkastl's published-theme preview loaded, but the final targeted browser attempt showed an empty cart after add/reload and never reached checkout. No API network error was captured in that attempt; the cause was not established. Its anonymous test cart was confirmed empty during cleanup. These browser limits do not establish a widget regression or a completed checkout validation.
- Real HTTP/browser fixture: camera stream, stop/retake/upload, manual camera exception, missing-items upload, private evidence and staff view passed. Desktop/mobile info interactions passed with numeric rules.
- Public customer pages/assets 200, anonymous order API 401, staff paths on customer host 404; deployed customer JS matches the image; original staff login 200. Worker mode/cutoffs checked with no queued fulfillment or mail work and no protection worker errors at activation.
- R2 follow-up: frontend 24/24, frontend security, shared service copy 3/3, build and Docker build pass. New-link/legacy-expiry/session regressions passed in isolated customer 17/17 and notification 7/7 suites. After public-copy edits, customer/policy rerun passed 20 tests with one unchanged video-environment skip (actual video handling was covered by the explicit earlier run); final policy copy suite 4/4.
- R2 desktop/mobile synthetic browser pass: all-closed entry, expired reason notice, shared period rule and UTC deadline, Back/Close/focus/Escape, mixed-item deselection and continuation, not-open/unknown dates and existing needs_info supplement. No new-claim POST or runtime error. Screenshots: `.impeccable/window-notice-review/`. Repeated live page/bundle/auth-boundary checks passed; runtime link lifetime is 90 days and mail remains disabled.

Before deployment: initial compose override backup `/tmp/protection-rules-compose-override.before.yml`; R2 immediate predecessor `/tmp/protection-rules-r2-compose-override.before.yml`; prior pilot manifests and flags `/tmp/protection-rules-store-config-before.json` (0600). Theme backups are under `shipping-protection/.backups/{amao04,hipkastl}/` from the installer. Do not blindly restore entire themes over later merchant edits.

For an application rollback, restore the prior override (in place), validate compose, and recreate only support-bridge with `--no-deps --no-build`. Additive tables/columns can remain. Restore only these two stores' config/flags if rolling back their storefront release too, after checking for later admin changes. Domain routing/certificate rollout is independent; its backup and TLS renewal-test limitation are documented in `us-seel-domain.md`.

R2 changes only the customer/backend application and new link issuance; it does not reinstall the pilots or change their activation cutoffs. Its immediate predecessor override retains the same fulfillment and disabled-mail settings. Already-issued 90-day links keep their persisted expiration even if the issuing application is rolled back.
