import { ShoplazzaOrderDetail, ShoplazzaTransaction } from './shoplazza-client';

export interface NormalizedOrder {
  storeSubdomain: string;
  storeName: string;
  orderId: string;
  orderNumber: string;
  customerEmail: string;
  customerName: string;
  orderStatus: string;
  fulfillmentStatus: string;
  orderAmount: string;
  orderCurrency: string;
  paymentStatus: string;
  paymentMethod: string;
  paidAt: string | null;
  refundStatus: string;
  refundAmount: string;
  transactionIdMasked: string;
  cardLast4: string;
  itemsJson: unknown[];
  shippingAddressJson: Record<string, unknown>;
  billingAddressJson: Record<string, unknown>;
  logisticsJson: Record<string, unknown>;
  paymentDetailJson: Record<string, unknown>;
  rawOrderJson: Record<string, unknown>;
}

function apiStr(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

function extractEmail(order: ShoplazzaOrderDetail): string {
  if (order.customer?.email) return order.customer.email.trim().toLowerCase();
  const ship = order.shipping_address as Record<string, unknown> | null;
  if (ship?.email) return String(ship.email).trim().toLowerCase();
  const bill = order.billing_address as Record<string, unknown> | null;
  if (bill?.email) return String(bill.email).trim().toLowerCase();
  return '';
}

function extractCustomerName(order: ShoplazzaOrderDetail): string {
  if (!order.customer) return '';
  const first = (order.customer.first_name || '').trim();
  const last = (order.customer.last_name || '').trim();
  return [first, last].filter(Boolean).join(' ') || '';
}

function extractCardLast4(transactions: ShoplazzaTransaction[]): string {
  for (const t of transactions) {
    const pd = t.payment_detail;
    if (!pd) continue;
    const card = pd.card_last_four || pd.card_last4 || '';
    const v = String(card).trim();
    if (v) return v;
  }
  return '';
}

function extractPaidAt(transactions: ShoplazzaTransaction[]): string | null {
  for (const t of transactions) {
    if (t.status === 'success' && t.created_at) {
      return apiStr(t.created_at) || null;
    }
  }
  return null;
}

function maskTransactionId(transactions: ShoplazzaTransaction[]): string {
  for (const t of transactions) {
    const id = apiStr(t.id);
    if (id) return `****${id.slice(-4)}`;
  }
  return '';
}

export function normalizeOrder(
  storeSubdomain: string,
  storeName: string,
  order: ShoplazzaOrderDetail,
  transactions: ShoplazzaTransaction[],
): NormalizedOrder {
  const cardLast4 = extractCardLast4(transactions);
  const paidAt = extractPaidAt(transactions);

  return {
    storeSubdomain,
    storeName,
    orderId: apiStr(order.id),
    orderNumber: apiStr(order.number) || apiStr(order.order_number),
    customerEmail: extractEmail(order),
    customerName: extractCustomerName(order),
    orderStatus: apiStr(order.status),
    fulfillmentStatus: apiStr(order.fulfillment_status),
    orderAmount: apiStr(order.total_price),
    orderCurrency: apiStr(order.currency),
    paymentStatus: apiStr(order.financial_status),
    paymentMethod: (apiStr(order.payment_method) || '').replace(/_/g, ' '),
    paidAt,
    refundStatus: '',
    refundAmount: '',
    transactionIdMasked: maskTransactionId(transactions),
    cardLast4,
    itemsJson: Array.isArray(order.line_items) ? order.line_items : [],
    shippingAddressJson: (order.shipping_address as Record<string, unknown>) || {},
    billingAddressJson: (order.billing_address as Record<string, unknown>) || {},
    logisticsJson: (order.shipping_line as Record<string, unknown>) || {},
    paymentDetailJson: transactions[0]?.payment_detail
      ? (transactions[0].payment_detail as Record<string, unknown>)
      : {},
    rawOrderJson: order as unknown as Record<string, unknown>,
  };
}
