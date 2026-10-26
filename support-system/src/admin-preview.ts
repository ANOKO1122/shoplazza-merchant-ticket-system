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
      ...buildTrackingDetails(snapshot),
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
      attachments: m.attachments || [],
      created_at: m.created_at,
    })),
  };
}

export function extractTrackingNo(snapshot: any): string {
  return buildTrackingDetails(snapshot).tracking_no;
}

export interface ShipmentView {
  id: string;
  tracking_numbers: string[];
  current_tracking_numbers: string[];
  tracking_company: string;
  updated_at: string;
}

const TRACKING_KEYS = [
  'tracking_numbers', 'trackingNumbers', 'tracking_number', 'tracking_no', 'trackingNumber',
  'waybill_no', 'waybillNo', 'waybill_number', 'waybillNumber', 'logistics_no', 'logisticsNo',
  'tracking_code', 'trackingCode', 'shipping_tracking_number', 'shippingTrackingNumber',
];

function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function trackingNumbers(value: any, depth = 0): string[] {
  if (!value || typeof value !== 'object' || depth > 5) return [];
  if (Array.isArray(value)) {
    return unique(value.flatMap(item => trackingNumbers(item, depth + 1)));
  }
  // Current tracking follows the canonical field priority. Cumulative numbers
  // are read separately from tracking_number_history.
  if (Array.isArray(value.tracking_items)) return trackingNumbers(value.tracking_items, depth + 1);
  for (const key of TRACKING_KEYS) {
    const raw = value[key];
    const numbers = unique(Array.isArray(raw) ? raw.map(text) : [text(raw)]);
    if (numbers.length) return numbers;
  }
  const numbers: string[] = [];
  // Legacy snapshots can keep tracking fields nested under logistics/address.
  for (const key of Object.keys(value)) {
    if (key === 'tracking_number_history') continue;
    numbers.push(...trackingNumbers(value[key], depth + 1));
  }
  return unique(numbers);
}

export function buildTrackingDetails(snapshot: any): {
  tracking_no: string;
  tracking_numbers: string[];
  shipments: ShipmentView[];
} {
  const fulfillments = snapshot?.raw_order_json?.fulfillments;
  const shipments: ShipmentView[] = [];
  if (Array.isArray(fulfillments)) {
    const byId = new Map<string, number>();
    for (const fulfillment of fulfillments) {
      if (!fulfillment || typeof fulfillment !== 'object' || Array.isArray(fulfillment)) continue;
      const companies = Array.isArray(fulfillment.tracking_items)
        ? unique(fulfillment.tracking_items.map((item: any) => text(item?.tracking_company)))
        : [];
      const current = trackingNumbers(fulfillment);
      const history = Array.isArray(fulfillment.tracking_number_history)
        ? fulfillment.tracking_number_history.filter((value: unknown) => typeof value === 'string').map(text) : [];
      const shipment: ShipmentView = {
        id: text(fulfillment.id),
        tracking_numbers: unique([...history, ...current]),
        current_tracking_numbers: current,
        tracking_company: companies.length ? companies.join(', ') : text(fulfillment.tracking_company),
        updated_at: text(fulfillment.updated_at),
      };
      const index = shipment.id ? byId.get(shipment.id) : undefined;
      if (index === undefined) {
        if (shipment.id) byId.set(shipment.id, shipments.length);
        shipments.push(shipment);
      } else {
        const retained = unique([...shipments[index].tracking_numbers, ...shipment.tracking_numbers]);
        const previousAt = Date.parse(shipments[index].updated_at);
        const incomingAt = Date.parse(shipment.updated_at);
        if (!Number.isFinite(previousAt) || (Number.isFinite(incomingAt) && incomingAt >= previousAt)) {
          shipments[index] = shipment;
        }
        shipments[index].tracking_numbers = retained;
      }
    }
  }
  let numbers = unique(shipments.flatMap(shipment => shipment.tracking_numbers));
  let current = unique(shipments.flatMap(shipment => shipment.current_tracking_numbers));
  // Once a structured fulfillment array exists, it is authoritative, including
  // an empty array. Do not attach unassigned legacy numbers to these packages.
  if (!Array.isArray(fulfillments)) {
    for (const root of [snapshot?.logistics_json, snapshot?.raw_order_json, snapshot?.shipping_address_json]) {
      numbers = trackingNumbers(root);
      if (numbers.length) break;
    }
    current = numbers;
  }
  return { tracking_no: current[0] || '', tracking_numbers: numbers, shipments };
}
