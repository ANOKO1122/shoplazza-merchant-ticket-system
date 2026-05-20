import { query } from './pg';
import { createTicketAccessToken, hashToken } from './token';

async function nextSequence(): Promise<number> {
  const r = await query(`SELECT nextval('support_tickets_id_seq') AS n`);
  return Number(r.rows[0].n);
}

export function generatePublicTicketNo(): string {
  const now = new Date();
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `T${y}${mo}${d}${String(Date.now() % 10000).padStart(4, '0')}`;
}

export async function createTicket(params: {
  storeSubdomain: string;
  storeName: string;
  orderId: string;
  orderNumber: string;
  customerEmail: string;
  customerName?: string;
  issueType?: string;
  description: string;
  bootstrapTokenHash?: string;
}): Promise<{
  publicTicketNo: string;
  accessToken: string;
}> {
  const publicTicketNo = generatePublicTicketNo();
  const accessToken = await createTicketAccessToken({
    publicTicketNo,
    customerEmail: params.customerEmail,
  });
  const accessTokenHash = hashToken(accessToken);

  const result = await query(
    `INSERT INTO support_tickets
      (public_ticket_no, store_subdomain, store_name, order_id, order_number,
       customer_email, customer_name, issue_type, status,
       customer_access_token_hash, bootstrap_token_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (store_subdomain, order_id, customer_email) DO UPDATE SET
       public_ticket_no = EXCLUDED.public_ticket_no,
       store_name = EXCLUDED.store_name,
       order_number = EXCLUDED.order_number,
       customer_name = EXCLUDED.customer_name,
       issue_type = EXCLUDED.issue_type,
       customer_access_token_hash = EXCLUDED.customer_access_token_hash,
       status = 'open',
       updated_at = now()
     RETURNING public_ticket_no`,
    [
      publicTicketNo,
      params.storeSubdomain,
      params.storeName,
      params.orderId,
      params.orderNumber,
      params.customerEmail,
      params.customerName || null,
      params.issueType || null,
      'open',
      accessTokenHash,
      params.bootstrapTokenHash || null,
    ],
  );

  const ticketNo = result.rows[0].public_ticket_no;

  // System message first, then customer message
  const now = new Date().toISOString();
  await query(
    `INSERT INTO support_ticket_messages
      (public_ticket_no, sender_type, content)
     VALUES ($1, 'system', $2)`,
    [ticketNo, `Consumer initiates a dispute at ${now}`],
  );

  await query(
    `INSERT INTO support_ticket_messages
      (public_ticket_no, sender_type, sender_email, sender_name, content)
     VALUES ($1, 'customer', $2, $3, $4)`,
    [ticketNo, params.customerEmail, params.customerName || null, params.description],
  );

  return { publicTicketNo: ticketNo, accessToken };
}

export async function getTicketByPublicNo(publicTicketNo: string) {
  const r = await query(
    `SELECT * FROM support_tickets WHERE public_ticket_no = $1`,
    [publicTicketNo],
  );
  return r.rows[0] || null;
}

export async function getTicketMessages(publicTicketNo: string) {
  const r = await query(
    `SELECT id, sender_type, sender_email, sender_name, content, created_at
     FROM support_ticket_messages
     WHERE public_ticket_no = $1
     ORDER BY created_at ASC`,
    [publicTicketNo],
  );
  return r.rows;
}

export async function addCustomerMessage(params: {
  publicTicketNo: string;
  customerEmail: string;
  customerName?: string;
  content: string;
}) {
  // Check consecutive customer message limit (max 5 without agent reply)
  const consecutiveCount = await countConsecutiveCustomerMessages(params.publicTicketNo);
  if (consecutiveCount >= 5) {
    throw new Error('You have reached the maximum of 5 consecutive messages. Please wait for a merchant response.');
  }

  await query(
    `INSERT INTO support_ticket_messages
      (public_ticket_no, sender_type, sender_email, sender_name, content)
     VALUES ($1, 'customer', $2, $3, $4)`,
    [params.publicTicketNo, params.customerEmail, params.customerName || null, params.content],
  );

  await query(
    `UPDATE support_tickets
     SET last_customer_message_at = now(), status = 'open', updated_at = now()
     WHERE public_ticket_no = $1`,
    [params.publicTicketNo],
  );
}

/**
 * Count consecutive customer messages (messages since the last non-customer message).
 * Returns the number of consecutive customer messages.
 */
export async function countConsecutiveCustomerMessages(publicTicketNo: string): Promise<number> {
  const r = await query(
    `SELECT sender_type FROM support_ticket_messages
     WHERE public_ticket_no = $1
     ORDER BY created_at DESC
     LIMIT 10`,
    [publicTicketNo],
  );

  let count = 0;
  for (const row of r.rows) {
    if (row.sender_type === 'customer') {
      count++;
    } else {
      break;
    }
  }
  return count;
}

export async function closeTicket(params: {
  publicTicketNo: string;
  closedBy: string;
}) {
  await query(
    `UPDATE support_tickets
     SET status = 'closed', closed_by = $2, closed_at = now(), updated_at = now()
     WHERE public_ticket_no = $1`,
    [params.publicTicketNo, params.closedBy],
  );
}

export async function getOrderSnapshot(params: {
  storeSubdomain: string;
  orderId: string;
  customerEmail: string;
}) {
  const r = await query(
    `SELECT * FROM support_order_snapshots
     WHERE store_subdomain = $1 AND order_id = $2 AND customer_email = $3`,
    [params.storeSubdomain, params.orderId, params.customerEmail],
  );
  return r.rows[0] || null;
}

export async function findExistingTicket(params: {
  storeSubdomain: string;
  orderId: string;
  customerEmail: string;
}) {
  const r = await query(
    `SELECT public_ticket_no, status FROM support_tickets
     WHERE store_subdomain = $1 AND order_id = $2 AND customer_email = $3
       AND status != 'closed'`,
    [params.storeSubdomain, params.orderId, params.customerEmail],
  );
  return r.rows[0] || null;
}

export async function listTickets(params: {
  status?: string;
  q?: string;
  page: number;
  pageSize: number;
  timeField?: string;
  timeRange?: string;
}) {
  const conditions: string[] = [];
  const values: (string | number)[] = [];
  let idx = 1;

  if (params.timeRange && params.timeField) {
    const now = new Date();
    if (params.timeRange === '24h') now.setHours(now.getHours() - 24);
    else if (params.timeRange === '2d') now.setDate(now.getDate() - 2);
    else if (params.timeRange === '7d') now.setDate(now.getDate() - 7);
    conditions.push(`${params.timeField} >= $${idx++}`);
    values.push(now.toISOString());
  }

  if (params.status && params.status !== 'all') {
    conditions.push(`status = $${idx++}`);
    values.push(params.status);
  }

  if (params.q) {
    const q = `%${params.q}%`;
    conditions.push(`(public_ticket_no ILIKE $${idx} OR order_number ILIKE $${idx+1} OR customer_email ILIKE $${idx+2})`);
    values.push(q, q, q);
    idx += 3;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const offset = (params.page - 1) * params.pageSize;

  const countR = await query(
    `SELECT COUNT(*) FROM support_tickets ${where}`,
    values,
  );
  const total = Number(countR.rows[0].count);

  const orderField = (params.timeField === 'created_at' || params.timeField === 'updated_at') ? params.timeField : 'created_at';
  const r = await query(
    `SELECT public_ticket_no, store_name, store_subdomain, order_id, order_number, customer_email, issue_type,
            status, arbitration_requested, last_customer_message_at, last_agent_message_at, updated_at, created_at
     FROM support_tickets ${where}
     ORDER BY ${orderField} DESC
     LIMIT $${idx++} OFFSET $${idx++}`,
    [...values, params.pageSize, offset],
  );

  return { total, tickets: r.rows };
}

export async function addAgentMessage(params: {
  publicTicketNo: string;
  agentId: number;
  agentName: string;
  content: string;
}) {
  await query(
    `INSERT INTO support_ticket_messages
      (public_ticket_no, sender_type, sender_email, sender_name, content)
     VALUES ($1, 'agent', $2, $3, $4)`,
    [params.publicTicketNo, `agent:${params.agentId}`, params.agentName, params.content],
  );

  await query(
    `UPDATE support_tickets
     SET last_agent_message_at = now(), status = 'waiting', updated_at = now()
     WHERE public_ticket_no = $1`,
    [params.publicTicketNo],
  );
}

export async function requestArbitration(publicTicketNo: string): Promise<void> {
  const now = new Date().toISOString();

  await query(
    `INSERT INTO support_ticket_messages
      (public_ticket_no, sender_type, content)
     VALUES ($1, 'system', $2)`,
    [publicTicketNo, `Consumer initiated an application for arbitration at ${now} and is awaiting arbitration by Platform.`],
  );

  await query(
    `INSERT INTO support_ticket_messages
      (public_ticket_no, sender_type, content)
     VALUES ($1, 'platform', $2)`,
    [publicTicketNo, "I'll do the arbitration process, and I'll get the result later."],
  );

  await query(
    `UPDATE support_tickets
     SET arbitration_requested = true, updated_at = now()
     WHERE public_ticket_no = $1`,
    [publicTicketNo],
  );
}

export async function updateTicketStatus(publicTicketNo: string, status: string) {
  const set: string[] = ['status = $2', 'updated_at = now()'];
  const values: (string | number)[] = [publicTicketNo, status];
  let idx = 3;

  if (status === 'closed') {
    set.push(`closed_at = now()`, `closed_by = 'agent'`);
  }

  await query(
    `UPDATE support_tickets SET ${set.join(', ')} WHERE public_ticket_no = $1`,
    values,
  );
}
