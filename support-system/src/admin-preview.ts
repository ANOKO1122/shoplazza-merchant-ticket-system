import { mapPaymentMethodDisplay } from './normalize-order';

export function buildCustomerPreviewResponse(params: {
  snapshot: any;
  ticket?: any | null;
  messages?: any[];
}) {
  const snapshot = params.snapshot || {};
  const ticket = params.ticket || null;
  const messages = params.messages || [];

  return {
    ok: true,
    preview_mode: true,
    mode: ticket ? 'existing_ticket' : 'new_ticket',
    order: {
      store_subdomain: snapshot.store_subdomain || '',
      store_name: snapshot.store_name || '',
      order_id: snapshot.order_id || '',
      order_number: snapshot.order_number || '',
      customer_email: snapshot.customer_email || '',
      customer_name: snapshot.customer_name || '',
      order_amount: snapshot.order_amount || '',
      order_currency: snapshot.order_currency || '',
      paid_at: snapshot.paid_at || null,
      payment_method: mapPaymentMethodDisplay(snapshot.payment_method),
      card_last4: snapshot.card_last4 || '',
      tracking_no: extractTrackingNo(snapshot),
      items: snapshot.items_json || [],
    },
    ticket: ticket ? {
      public_ticket_no: ticket.public_ticket_no,
      status: ticket.status,
      issue_type: ticket.issue_type || '',
      arbitration_requested: ticket.arbitration_requested || false,
      created_at: ticket.created_at,
      updated_at: ticket.updated_at,
    } : null,
    messages: messages.map((m: any) => ({
      id: m.id,
      sender_type: m.sender_type,
      sender_name: m.sender_name,
      content: m.content,
      created_at: m.created_at,
    })),
  };
}

export function extractTrackingNo(snapshot: any): string {
  const roots: any[] = [
    snapshot?.logistics_json,
    snapshot?.raw_order_json,
    snapshot?.shipping_address_json,
  ];
  if (snapshot?.raw_order_json?.fulfillments) {
    roots.unshift(snapshot.raw_order_json.fulfillments);
  }
  for (const root of roots) {
    const found = findTrackingNo(root, 0);
    if (found) return found;
  }
  return '';
}

function findTrackingNo(value: any, depth: number): string {
  if (!value || depth > 5) return '';
  if (typeof value === 'string' || typeof value === 'number') return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findTrackingNo(item, depth + 1);
      if (found) return found;
    }
    return '';
  }
  const keys = [
    'tracking_no',
    'tracking_number',
    'trackingNumber',
    'tracking_numbers',
    'trackingNumbers',
    'waybill_no',
    'waybillNo',
    'waybill_number',
    'waybillNumber',
    'logistics_no',
    'logisticsNo',
    'tracking_code',
    'trackingCode',
    'shipping_tracking_number',
    'shippingTrackingNumber',
  ];
  for (const key of keys) {
    const raw = value[key];
    if (Array.isArray(raw)) {
      const first = raw.map(v => String(v || '').trim()).find(Boolean);
      if (first && first.length >= 6) return first;
    } else if (raw != null && raw !== '') {
      const text = String(raw).trim();
      if (text && text.length >= 6) return text;
    }
  }
  for (const key of Object.keys(value)) {
    const found = findTrackingNo(value[key], depth + 1);
    if (found) return found;
  }
  return '';
}
