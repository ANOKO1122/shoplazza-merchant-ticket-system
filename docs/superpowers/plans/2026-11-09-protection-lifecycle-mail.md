# Protection shipment/completion notifications and quicker location capture

The customer portal accepts the first valid fresh device location immediately.
It still requests high accuracy, displays the original coordinates and the
device's accuracy estimate, allows a voluntary retry, and requires location for
package-not-received requests. A request without a usable reading stops after
eight seconds and shows the existing English permission guidance.

Protection email delivery uses the existing durable outbox and dedicated
`support@us-seel.com` sender. Add an editable shipment template alongside the
completion and claim-update templates. The first genuine merchandise shipment
and the merchant's recorded order completion each produce one event per order.
Protection-only fulfillment must not trigger a shipment notification. Partial
shipment wording must not imply that every item has shipped; completion wording
must not imply actual carrier delivery.

Enqueue atomically with protection snapshot indexing. Persist an activation
timestamp so reindexing historical records cannot bulk-send old notifications.
Retain the current order identity, paid/protection eligibility, cancellation,
refund and category-specific unsubscribe checks through delivery. Reuse secure
customer links, leases, retry behavior and stable Message-IDs. No real order is
advanced or completed to test the notifications.

On inspection, the real order `OJSGPF62957` (`SP-0000000002`) was paid and waiting
for shipment, with neither shipment nor completion timestamps. Both configured
stores already have shipment and `orders/finished` subscriptions. Its future
milestones can therefore use the normal event path, without historical catch-up.

Verify with isolated database lifecycle and existing claim-notification tests,
the full test/build commands, and desktop/mobile customer-flow regressions.
Deploy the bridge image with the existing private-app build target and persistent
data. Verify live health, activation, templates and the unchanged real order.
Commit and push only the system repository as ANOKO1122; do not push private app
code.
