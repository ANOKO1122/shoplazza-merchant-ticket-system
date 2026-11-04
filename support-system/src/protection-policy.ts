/** Time provenance is retained separately from the dates used by a request window. */
export type CoveredReason = 'delayed' | 'lost' | 'damaged' | 'stolen';
export interface ProtectionRequestWindow {
  reason: CoveredReason; status: 'open' | 'not_open' | 'expired' | 'unknown';
  opens_at: string | null; closes_at: string | null; basis: string; message: string;
}
export interface ProtectionCoverage {
  policy_version: string; evaluated_at: string; windows: ProtectionRequestWindow[]; timestamps: ProtectionTimeline;
}
export type ProtectionPolicyMode = 'shipment' | 'completion';
export function configuredProtectionPolicyMode(): ProtectionPolicyMode | null {
  const value = process.env.SUPPORT_PROTECTION_POLICY_BASIS;
  return value === 'shipment' || value === 'completion' ? value : null;
}
export interface ProtectionTimeline {
  cancelled?: boolean;
  ordered_at: string | null;
  shipped_at: string | null; shipped_source: string | null;
  delivered_at: string | null; delivered_source: string | null;
  completed_at: string | null; completed_source: string | null;
  items: Record<string, { shipped_at: string | null; shipped_source: string | null; delivered_at: string | null; delivered_source: string | null }>;
}
const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
function date(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value); return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
export function extractProtectionTimeline(value: unknown, physicalItems: Array<string | { id: string; quantity: number }>): ProtectionTimeline {
  const raw = record(value), itemRows = physicalItems.map(item => typeof item === 'string' ? { id: item, quantity: 1 } : item);
  const ids = new Set(itemRows.map(item => item.id));
  const parcels = (Array.isArray(raw.fulfillments) ? raw.fulfillments.map(record) : []).filter((p: Record<string, any>) =>
    ['shipped', 'finished'].includes(p.status) && Array.isArray(p.line_items) && p.line_items.some((i: any) => ids.has(String(i.id || i.line_item_id || ''))));
  const items: ProtectionTimeline['items'] = {};
  for (const item of itemRows) {
    const matches = parcels.flatMap((p: any) => p.line_items.filter((l: any) => String(l.id || l.line_item_id || '') === item.id).map((l: any) => ({ parcel: p, quantity: l.ship_quantity ?? l.quantity })));
    const valid = Number.isSafeInteger(item.quantity) && item.quantity > 0 && matches.length > 0
      && matches.every((m: any) => Number.isSafeInteger(m.quantity) && m.quantity > 0)
      && matches.reduce((sum: number, m: any) => sum + m.quantity, 0) === item.quantity;
    const shipped = matches.map((m: any) => ({ at:date(m.parcel.shipped_at) || date(m.parcel.created_at),source:date(m.parcel.shipped_at)?'merchant_fulfillment.shipped_at':'merchant_fulfillment.created_at' }));
    const delivered = matches.map((m: any) => date(m.parcel.delivered_at));
    const lastShipment = valid && shipped.every((s:any)=>s.at) ? [...shipped].sort((a:any,b:any)=>a.at.localeCompare(b.at)).slice(-1)[0]! : null;
    const shippedAt=lastShipment?.at||null;
    const deliveredAt = valid && delivered.every(Boolean) ? [...delivered].sort().slice(-1)[0]! : null;
    items[item.id] = { shipped_at: shippedAt, shipped_source: shippedAt ? lastShipment?.source || null : null,
      delivered_at: deliveredAt, delivered_source: deliveredAt ? 'fulfillment.delivered_at' : null };
  }
  const shipments = Object.values(items).map(item => item.shipped_at), deliveries = Object.values(items).map(item => item.delivered_at);
  const shipped = shipments.length && shipments.every(Boolean) ? [...shipments].sort().slice(-1)[0]! : null;
  const delivered = deliveries.length && deliveries.every(Boolean) ? [...deliveries].sort().slice(-1)[0]! : null;
  const completed = date(raw.finished_at) || (['order.finished_at', 'orders/finished.updated_at'].includes(raw._support_completed_source) ? date(raw._support_completed_at) : null);
  return { ordered_at: date(raw.created_at), shipped_at: shipped,cancelled:!!(raw.cancelled_at||raw.canceled_at),
    shipped_source: shipped ? Object.values(items).find(item=>item.shipped_at===shipped)?.shipped_source||null : null,
    delivered_at: delivered, delivered_source: delivered ? 'fulfillment.delivered_at' : null,
    completed_at: completed, completed_source: completed ? (date(raw.finished_at) ? 'order.finished_at' : raw._support_completed_source) : null, items };
}

const DAY = 24 * 60 * 60 * 1000;
const REASONS: CoveredReason[] = ['delayed', 'lost', 'damaged', 'stolen'];
/** Missing dates are a verification requirement; they never start a clock at today's date. */
export function evaluateProtectionCoverage(order: { timeline?: ProtectionTimeline; items: Array<{ id: string; is_protection: boolean }> }, options: {
  mode?: ProtectionPolicyMode | null; now?: number; itemIds?: string[];
} = {}): ProtectionCoverage {
  const mode = options.mode === undefined ? configuredProtectionPolicyMode() : options.mode;
  const now = options.now ?? Date.now(), timeline = order.timeline || extractProtectionTimeline({}, []);
  const ids = options.itemIds || order.items.filter(item => !item.is_protection).map(item => item.id);
  const completion = date(timeline.completed_at), ordered = date(timeline.ordered_at);
  const windows = REASONS.map((reason): ProtectionRequestWindow => {
    const isArrival = reason === 'damaged' || reason === 'stolen';
    let anchor: string | null = completion;
    if (!isArrival && mode === 'shipment') {
      const dates = ids.map(id => date(timeline.items?.[id]?.shipped_at));
      anchor = dates.length > 0 && dates.every(Boolean) ? dates.sort().slice(-1)[0]! : null;
    }
    const basis = isArrival || mode === 'completion' ? 'Based on the store’s recorded order completion date.' : 'Based on the selected items’ recorded shipment dates.';
    const opens = anchor ? Date.parse(anchor) + (reason === 'delayed' ? 30 : reason === 'lost' ? 60 : 0) * DAY : null;
    const closes = isArrival ? (completion ? Date.parse(completion) + 7 * DAY : null) : (ordered ? Date.parse(ordered) + 90 * DAY : null);
    let status: ProtectionRequestWindow['status'] = !mode || opens === null || closes === null || !ids.length ? 'unknown'
      : now > closes || opens > closes ? 'expired' : now < opens ? 'not_open' : 'open';
    const message = status === 'unknown' ? 'The dates for this request are not available yet. A new request cannot be submitted until these dates are confirmed.'
      : status === 'expired' ? (opens !== null && closes !== null && opens > closes
        ? 'The required waiting period ends after the last request date. A new request is not available for this issue.'
        : 'The time window for a new request has ended. Existing requests can still be reviewed.')
      : status === 'not_open' ? 'This request window has not opened yet.' : 'You can submit this type of request now.';
    return { reason, status, opens_at: opens === null ? null : new Date(opens).toISOString(), closes_at: closes === null ? null : new Date(closes).toISOString(), basis, message };
  });
  return { policy_version: `2026-11-03:${mode || 'unconfigured'}`, evaluated_at: new Date(now).toISOString(), windows, timestamps: timeline };
}
