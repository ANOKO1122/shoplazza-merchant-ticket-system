# Shipping protection administration

The merchant requested an integrated management backend with statistics, store component installation/health/theme compatibility, and claims review. Payouts occur outside this system. Customer claims portal, emails, coverage windows and claim deadlines are a later phase. Existing two stores remain enabled.

## Approach and decisions

Extend the existing support backend and authenticated admin shell. A React + TypeScript entry compiled with esbuild provides the new workspace; PostgreSQL/Express remain authoritative. This is an implementation choice, not a claim that TypeScript itself improves runtime performance. Server pagination, indexed queries, cancellable requests, and a small separate bundle control cost. Rewriting the ticket UI or creating a separate authentication/database would add unrelated work.

The UI inherits the existing navy sidebar, blue actions, neutral surfaces and dense operational tables. Four tabs: overview, protected orders, claims review, stores. Claims use list/detail with history and visible order context. Unknown states never display as healthy. No invented customers or statistics in production empty states.

## Business boundaries

- Recognize own protection by configured per-store product/variant IDs, never display name or generic SPU alone. Deduplicate order snapshots by store/order and retain paid amount/currency; never sum currencies together.
- Protected orders expose fee, items, current order/refund/fulfillment state, source freshness and related claims. No invented coverage expiry while timing policy is pending.
- Claims support internal registration now (customer portal later), selected regular order items, reason, amount, notes, assignee and audit history. State machine: submitted, reviewing, needs_info, approved, rejected, closed. Approved means review passed, never payout sent. Optional manual closure records external completion reference, without payment API.
- Validate amount against selected items/order currency and remaining approved claims; prevent duplicate active claims for overlapping items; optimistic revision guards prevent competing decisions. Rejection and manual closure require explanatory notes. Audit captures actor and timestamps transactionally.
- Reuse login; all endpoints authenticated, mutation same-origin checked. Only admins may install/enable/disable components. Credentials stay server-side.
- Store management distinguishes local intended state from last remote health probe; checks active theme, required credentials, products, cart asset and checkout publication. Known themes can use existing installer; unknown themes are marked adaptation required and never automatically patched. Install actions are persistent serialized jobs with success/failure and readable diagnostics.
- First valid physical shipment on a paid order should fulfill only remaining protection lines, never mark the whole order complete. Exact platform write semantics and notification side effects must be verified before auto activation. Service fulfillment never ends customer coverage.

## Verification

Use disposable PostgreSQL and synthetic orders, never real customer claim decisions or paid transactions. Test auth, cross-origin mutations, money validation, duplicate/concurrent claims, cursor synchronization and installation job concurrency/failures. Run existing suite/build and browser desktop/mobile plus navigation and keyboard checks. External installation remains available as a real operation but tests only probe the two installed stores.
