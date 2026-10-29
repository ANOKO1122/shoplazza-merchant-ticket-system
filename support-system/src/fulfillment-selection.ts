// Share eligibility and due-time rules between selection and backlog reporting.
// $1: enabled stores; $2: optional explicitly requested order; $3: per-store quota (selection only).
const eligibleOrders = `WITH active_tickets AS (
  SELECT store_subdomain, order_id
  FROM support_tickets
  WHERE store_subdomain = ANY($1::text[])
    -- updated_at is maintained by human ticket actions (including reopen/arbitration), not order sync or views.
    AND GREATEST(created_at, updated_at, last_customer_message_at, last_agent_message_at, closed_at)
      >= now() - interval '30 days'
  GROUP BY store_subdomain, order_id
), paid_orders AS (
  SELECT snapshot.store_subdomain, snapshot.order_id,
         MAX(snapshot.order_number) AS order_number,
         MAX(COALESCE(
           CASE WHEN pg_input_is_valid(dates.placed_at, 'timestamp with time zone') THEN dates.placed_at::timestamptz END,
           CASE WHEN pg_input_is_valid(dates.created_at, 'timestamp with time zone') THEN dates.created_at::timestamptz END,
           snapshot.paid_at
         )) AS ordered_at,
         BOOL_OR(ticket.order_id IS NOT NULL) AS priority
  FROM support_order_snapshots snapshot
  CROSS JOIN LATERAL jsonb_to_record(snapshot.raw_order_json) AS dates(placed_at text, created_at text)
  LEFT JOIN active_tickets ticket
    ON ticket.store_subdomain = snapshot.store_subdomain AND ticket.order_id = snapshot.order_id
  WHERE snapshot.payment_status IN ('paid', 'partially_refunded')
    AND snapshot.store_subdomain = ANY($1::text[])
    AND ($2::text IS NULL OR snapshot.order_id = $2)
  GROUP BY snapshot.store_subdomain, snapshot.order_id
), eligible_orders AS (
  SELECT * FROM paid_orders
  WHERE $2::text IS NOT NULL OR priority
    OR ordered_at BETWEEN now() - interval '30 days' AND now()
), scheduled_orders AS (
  SELECT paid.*, state.last_attempt_at,
         CASE WHEN paid.priority AND state.last_error IS NULL AND state.last_checked_at IS NOT NULL
              THEN LEAST(state.next_check_at, state.last_checked_at + interval '6 hours')
              ELSE state.next_check_at END AS due_at
  FROM eligible_orders paid
  LEFT JOIN support_fulfillment_sync_state state
    ON state.store_subdomain = paid.store_subdomain AND state.order_id = paid.order_id
), due_orders AS (
  SELECT * FROM scheduled_orders
  WHERE $2::text IS NOT NULL OR due_at IS NULL OR due_at <= now()
)`;

export const FULFILLMENT_CANDIDATES_SQL = `${eligibleOrders}, rotated_orders AS (
  SELECT due.*, ROW_NUMBER() OVER (
    PARTITION BY store_subdomain, priority, (last_attempt_at IS NULL)
    ORDER BY due_at ASC NULLS FIRST, ordered_at DESC NULLS LAST, order_id
  ) AS queue_position
  FROM due_orders due
), ranked_orders AS (
  SELECT rotated.*, ROW_NUMBER() OVER (
    PARTITION BY store_subdomain
    ORDER BY priority DESC, queue_position, (last_attempt_at IS NULL), order_id
  ) AS store_position
  FROM rotated_orders rotated
)
SELECT store_subdomain, order_id, order_number, priority
FROM ranked_orders
WHERE store_position <= $3
ORDER BY store_subdomain, store_position`;

export const FULFILLMENT_REMAINING_SQL = `${eligibleOrders}
SELECT store_subdomain, COUNT(*)::int AS remaining_due
FROM due_orders GROUP BY store_subdomain`;
