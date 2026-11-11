import type { CustomerIssueCode, CustomerSelection } from '../../src/protection-customer-types';
export const issueLabels: Record<CustomerIssueCode, string> = { damaged: 'My item arrived damaged', missing_items: 'Items are missing from my package', wrong_item: 'I received the wrong item', delivered_not_received: 'My order is marked complete, but I have not received my package', not_arrived: 'My package has not arrived', delayed: 'My shipment is significantly delayed', other: 'Another delivery or product issue' };
export function issueOptions(received: boolean) {
  const keys: CustomerIssueCode[] = received ? ['damaged', 'missing_items'] : ['delivered_not_received', 'not_arrived', 'delayed'];
  return keys.map(value => ({ value, label: issueLabels[value] }));
}
type SelectionItem = { id: string; quantity: number; amount_cents: number | null; available_quantity: number; available_amount_cents: number | null; has_active_claim: boolean };
export function groupShipmentItems<T extends { id: string; quantity: number }>(items: T[], shipments: Array<{ item_quantities: CustomerSelection[] }>) {
  const remaining = new Map(items.map(item => [item.id, item.quantity]));
  const byId = new Map(items.map(item => [item.id, item]));
  const shipped = shipments.map(shipment => {
    const entries: Array<{ item: T; quantity: number }> = [];
    for (const selection of shipment.item_quantities) {
      const item = byId.get(selection.item_id);
      const available = remaining.get(selection.item_id) || 0;
      const quantity = Math.min(selection.quantity, available);
      if (!item || !Number.isSafeInteger(quantity) || quantity <= 0) continue;
      const existing = entries.find(entry => entry.item.id === item.id);
      if (existing) existing.quantity += quantity;
      else entries.push({ item, quantity });
      remaining.set(item.id, available - quantity);
    }
    return entries;
  });
  const unassigned = items.flatMap(item => {
    const quantity = remaining.get(item.id) || 0;
    return quantity > 0 ? [{ item, quantity }] : [];
  });
  return { shipped, unassigned };
}
export function validSelections(selections: CustomerSelection[], items: SelectionItem[]): boolean {
  if (!selections.length || new Set(selections.map(item => item.item_id)).size !== selections.length) return false;
  return selections.every(selection => {
    const item = items.find(item => item.id === selection.item_id);
    return item && !item.has_active_claim && Number.isSafeInteger(selection.quantity) && selection.quantity > 0 && selection.quantity <= item.available_quantity;
  });
}
export function selectionAmount(selections: CustomerSelection[], items: SelectionItem[], orderRemaining?: number | null): number | null {
  if (orderRemaining === null) return null;
  let total = 0;
  for (const selection of selections) {
    const item = items.find(item => item.id === selection.item_id);
    if (!item || item.amount_cents == null || item.available_amount_cents == null || item.quantity <= 0) return null;
    total += Math.min(item.available_amount_cents, Math.floor(item.amount_cents * selection.quantity / item.quantity));
  }
  return orderRemaining == null ? total : Math.min(total, Math.max(0, orderRemaining));
}
export function safeImage(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
}
export function evidenceUrl(value: string): string | undefined { return /^\/api\/protection\/evidence\/[A-Za-z0-9_-]+$/.test(value) ? value : undefined; }
export function money(cents: number | null | undefined, currency: string): string {
  if (cents == null) return 'Amount under review';
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100) + ` ${currency}`; } catch { return `${(cents / 100).toFixed(2)} ${currency}`; }
}
export function date(value: string | null | undefined): string {
  if (!value) return 'Not available';
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? 'Not available' : parsed.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}
export function takeAccessToken(location: { href: string }, history: { replaceState(state: unknown, unused: string, url: string): void }): string | null {
  const url = new URL(location.href);
  const access = new URLSearchParams(url.hash.slice(1)).get('access');
  if (url.hash) history.replaceState(null, '', url.pathname + url.search);
  return access;
}
export const statusLabels: Record<string, string> = { submitted: 'Request received', reviewing: 'Under review', needs_info: 'More information needed', approved: 'Approved', rejected: 'Not approved', closed: 'Handled externally' };
export function shipmentLabel(status: string): string {
  const labels: Record<string, string> = { finished: 'Completion recorded by store', completed: 'Completion recorded by store', delivered: 'Delivered', shipped: 'On the way', fulfilled: 'On the way', pending: 'Preparing shipment', cancelled: 'Shipment cancelled', canceled: 'Shipment cancelled' };
  return labels[status] || 'Shipment status pending';
}
