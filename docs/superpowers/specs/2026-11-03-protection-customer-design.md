# Shipping protection customer portal

The customer portal runs at `https://us-seel.com`; the existing support domain continues to host staff tools. It uses the merchant's Shipping Protection identity, with Seel references informing layout only. It offers refund requests, never returns or automated payouts.

An emailed, order-scoped opaque capability is exchanged for a host-only session. The capability is carried in the URL fragment and removed immediately. Only the authorized protection contract and its claims are visible. The public landing page explains how to use the secure link without revealing orders from an email/number lookup.

The order page shows the merchant, order, permanent protection number, goods, shipment references, and claim history. It distinguishes merchant-system completion from verified carrier delivery. A refund wizard asks whether the package was received, branches into relevant problems, selects affected quantities, collects a description and private images/videos, optionally requests location after an explicit explanation, and confirms before submission. Location refusal does not block submission. No eligibility deadlines or delivery timestamps are invented.

Claims use the existing review/budget rules. Rejection permits a new claim number under the same contract. Pending claims can receive supplemental evidence. Server checks quantities, order ownership, idempotency, current refund/cancellation state, and cumulative allocations. Staff can see questionnaire/evidence/location and write a separate customer-facing message; internal notes and external payout references remain private.

Evidence uses a private persistent directory and authenticated streaming endpoints, including video ranges. File limits, genuine media checks, expiry of unsubmitted uploads, and contract ownership apply before publication.

The template library gains `protection_completion_notice`, displayed as **完成模板（物流保障）**, using responsive table HTML with a status headline, greeting, order and shipment summary, and a secure `us-seel.com` CTA. Template creation does not activate automatic email sends. Completion text must not assert carrier delivery without evidence. Existing ticket templates and links retain their domain.

The new host allows only customer pages, bundles, and customer APIs. Admin and existing ticket endpoints are inaccessible through it. Tests use synthetic customers in isolated databases, with no real claim submissions or emails.
