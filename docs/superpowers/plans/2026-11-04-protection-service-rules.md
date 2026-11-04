# Shipping protection service rules and customer notifications

## Confirmed scope

- Activate the customer portal on `https://us-seel.com` with its independent certificate and restricted public paths. Keep staff routes on the existing support domain.
- English service details on cart, checkout, customer order, and claim detail. Accessible information control supports hover, focus, touch, Escape and outside dismissal without toggling the purchase checkbox.
- Shipping/delivery damage, loss/missing items, theft and delay only. No insurance terminology, Seel affiliation, automatic-refund promise or return workflow. Existing legacy requests remain readable.
- Screenshot windows: delay +30 days from shipment; loss +60 days from shipment; both close 90 days after order creation. Damage/theft through 7 days after the selected date. The merchant's completion timestamp replaces delivery; it is not a carrier-confirmed scan.
- One generic editable claim-update email on transitions to needs_info, approved, rejected or externally handled. Queue atomically with the status update; no historical sweep, no payment execution. Default off until the sender choice/configuration is settled.
- Protection-item fulfillment follows the order `finished` event, replacing the old first-shipment proposal. Future activation only, configured protection product IDs only, authoritative reconciliation and uncertain-create protection. Never mark physical lines or mixed packages finished.

## Confirmed follow-up decisions

1. User selected **shipment** mode: completion replaces only delivery. Delay/loss retain the selected items' merchant shipment anchors and the 90-day-from-order cap. Damage/theft use the original merchant completion date through day 7.
2. User selected **wait for the dedicated sender**. Keep `SUPPORT_PROTECTION_MAIL_MODE=disabled`; do not reuse the ticket sender. New status changes remain queued until the dedicated domain is configured. Website HTTPS remains enabled independently.
3. User requested an English expired-window notice after selecting an issue, with no customer-support entry. Keep valid links and existing request history usable; show the applicable deadline, allow Back/Close, and preserve eligible item selection when package windows differ. New access links last 90 days; existing links retain their original expiry and sessions remain at most 12 hours.

## Implementation and validation

1. Preserve completion-time provenance in order snapshots, including `orders/finished` event time. Do not treat a later API `updated_at` or current server time as the original completion date.
2. Calculate windows server-side per selected item/package; missing/ambiguous time data requires manual verification. Snapshot the applicable rules at submission; later reviews and supplemental evidence can continue after the new-request deadline.
3. Add shared service-details presentation and matching customer eligibility feedback. Include the shared module in extension release signatures and Docker build paths.
4. Add durable claim notification queue, secure order-scoped links, status/revision deduplication, retry and separate sender modes. SMTP delivery has an unavoidable accepted-before-database-commit uncertainty.
5. Add the narrowly scoped future-only service fulfillment worker, permission/read checks and independent review before enabling it.
6. Test isolated PostgreSQL, backend, frontend, camera/claim behavior, desktop/mobile information controls and Docker build. No real customer messages or order mutations for tests.
7. Publish both pilot widgets with the confirmed shipment-mode timing copy. Deploy the reviewed service and validate HTTPS/assets/host isolation without exposing private credentials or tokens.

## DNS activation evidence

- Public A: 104.194.95.40. Independent Let's Encrypt certificate through 2027-02-02.
- `/` and `/protection` and customer bundles: 200. Anonymous order API: 401. Admin/support/uploads/mailpit: 404. Cross customer-SNI/staff-Host: 421. Existing staff login: 200.
- Found and corrected a static-directory redirect collision for `/protection`; customer ingress directly serves the app root and the explicit app page precedes static middleware.
