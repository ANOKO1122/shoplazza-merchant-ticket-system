import { useEffect, useRef } from 'react';
import type { CustomerIssueCode, CustomerOrderResponse, CustomerSelection, ProtectionRequestWindow } from '../../src/protection-customer-types';
import { Icon } from './shared';
import { serviceWindowRules, type ServicePolicyBasis } from './service-details';

export const requestReasonLabels: Record<ProtectionRequestWindow['reason'], string> = { damaged: 'Damage', lost: 'Loss or missing items', stolen: 'Theft', delayed: 'Delay' };
const windowLabels: Record<ProtectionRequestWindow['status'], string> = { open: 'Open for requests', not_open: 'Not yet open', expired: 'Request window closed', unknown: 'Date needs confirmation' };
export function requestReason(issue: CustomerIssueCode | string | null): ProtectionRequestWindow['reason'] | null {
  if (issue === 'damaged' || issue === 'delayed') return issue;
  if (['missing_items', 'not_arrived', 'lost'].includes(issue || '')) return 'lost';
  if (['delivered_not_received', 'stolen'].includes(issue || '')) return 'stolen';
  return null;
}
export function requestDate(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Not yet available';
  return new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' }).format(new Date(value));
}
type OrderItem = CustomerOrderResponse['order']['items'][number];
export type WindowItem = { id: string; title: string; window?: ProtectionRequestWindow };
export function canOpenRequest(eligibility: CustomerOrderResponse['eligibility']): boolean {
  return eligibility.can_submit || eligibility.reason_code === 'request_window';
}
export function itemRequestWindow(issue: CustomerIssueCode | string | null, item?: OrderItem): ProtectionRequestWindow | undefined {
  return item?.request_windows?.find(window => window.reason === requestReason(issue));
}
function hasNoRequestPeriod(window?: ProtectionRequestWindow): boolean {
  return !!window?.opens_at && !!window.closes_at && Date.parse(window.opens_at) > Date.parse(window.closes_at);
}
export function windowMessage(window?: ProtectionRequestWindow): string {
  if (window?.status === 'expired' && hasNoRequestPeriod(window)) return 'The required waiting period ends after the request deadline, so a new request cannot be submitted.';
  if (window?.status === 'open') return 'You can submit a new request within these dates.';
  if (window?.status === 'expired') return 'The deadline for a new request has passed.';
  if (window?.status === 'not_open') return 'This request window has not opened. You can return once it opens.';
  return 'The dates needed to check this request are not available. A new request cannot be submitted until these dates are available.';
}
export function blockedWindowItems(issue: CustomerIssueCode | null, selections: CustomerSelection[], items: OrderItem[]): WindowItem[] {
  return selections.map(selection => {
    const item = items.find(item => item.id === selection.item_id);
    return { id: selection.item_id, title: item?.title || 'Order item', window: itemRequestWindow(issue, item) };
  }).filter(item => item.window?.status !== 'open');
}
export function reasonWindowNotice(issue: CustomerIssueCode, selections: CustomerSelection[], items: OrderItem[]): { items: WindowItem[]; returnToItems: boolean } | null {
  const available = items.filter(item => !item.has_active_claim && item.available_quantity > 0);
  const all = blockedWindowItems(issue, available.map(item => ({ item_id: item.id, quantity: 1 })), items);
  if (available.length && all.length === available.length) return { items: all, returnToItems: false };
  const selected = blockedWindowItems(issue, selections, items);
  return selected.length ? { items: selected, returnToItems: true } : null;
}
export function selectedWindowProblem(issue: CustomerIssueCode | null, selections: CustomerSelection[], items: OrderItem[]): string | null {
  const reason = requestReason(issue);
  if (!reason) return 'This type of issue is outside this service.';
  const blocked = blockedWindowItems(issue, selections, items);
  return blocked.length ? windowMessage(blocked[0].window) : null;
}
function WindowDates({ window }: { window?: ProtectionRequestWindow }) {
  return <><span className={`cp-window-status cp-window-${window?.status || 'unknown'}`}>{windowLabels[window?.status || 'unknown']}</span><dl className="cp-window-dates"><div><dt>Opens</dt><dd>{requestDate(window?.opens_at || null)}</dd></div><div><dt>Request deadline</dt><dd>{requestDate(window?.closes_at || null)}</dd></div></dl><p>{windowMessage(window)}</p>{window?.basis && <p className="cp-window-basis">{window.basis}</p>}</>;
}
export function ItemRequestWindow({ issue, item }: { issue: CustomerIssueCode | null; item: OrderItem }) {
  const window = itemRequestWindow(issue, item);
  return <span className="cp-item-window"><span className={`cp-window-status cp-window-${window?.status || 'unknown'}`}>{windowLabels[window?.status || 'unknown']}</span>{window?.status === 'not_open' && <small>Opens {requestDate(window.opens_at)}</small>}{(window?.status === 'expired' || window?.status === 'open') && <small>Deadline {requestDate(window.closes_at)}</small>}{(!window || window.status === 'unknown') && <small>Request dates are not yet available.</small>}</span>;
}
export function RequestWindowNotice({ issue, items, basis }: { issue: CustomerIssueCode | null; items: WindowItem[]; basis?: ServicePolicyBasis }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, []);
  const statuses = new Set(items.map(item => item.window?.status || 'unknown'));
  const status = statuses.size === 1 ? [...statuses][0] : 'mixed';
  const noPeriod = items.some(item => hasNoRequestPeriod(item.window));
  const title = status === 'expired' ? noPeriod ? 'No request window is available' : 'This request window has closed' : status === 'not_open' ? 'Requests are not open yet' : status === 'unknown' ? 'Request dates are not available' : 'These items cannot be included';
  const reason = requestReason(issue);
  const rule = reason ? serviceWindowRules(basis)[reason] : null;
  return <section className="cp-window-notice"><span className="cp-window-notice-icon"><Icon name="info" size={29} /></span><h3 ref={heading} tabIndex={-1}>{title}</h3><p>{reason && <strong>{requestReasonLabels[reason]}: </strong>}{status === 'expired' ? noPeriod ? 'The required waiting period extends beyond the request deadline for one or more items below. A new request cannot be submitted for these items.' : 'The deadline has passed for the items below. A new request for this issue cannot be submitted.' : status === 'not_open' ? 'A new request for these items can be submitted once the request window opens.' : status === 'unknown' ? 'A new request cannot be submitted until the required order dates are available.' : 'Each item has its own request dates. Only items with an open window can be included in a new request.'}</p>{rule && <p className="cp-window-notice-rule">{rule}</p>}<ul>{items.map(item => <li key={item.id}><h4>{item.title}</h4><WindowDates window={item.window} /></li>)}</ul><p className="cp-window-notice-existing">Your order and existing requests remain available. You can still add information to a request that is under review.</p></section>;
}
export function OrderRequestWindows({ data }: { data: CustomerOrderResponse }) {
  if (!data.coverage) return null;
  return <details className="cp-order-windows"><summary>Request windows <span>Check dates for damage, loss, theft and delay</span></summary><p>These dates are based on the order information supplied by the store. Dates for individual items may differ when packages ship separately.</p><ul>{data.coverage.windows.map(window => <li key={window.reason}><h4>{requestReasonLabels[window.reason]}</h4><WindowDates window={window} /></li>)}</ul><p className="cp-window-timezone">All request times are shown in UTC. Select the affected items to check their dates before submitting.</p></details>;
}
export function SelectedRequestWindows({ data, selections, issue, existing = false }: { data: CustomerOrderResponse; selections: CustomerSelection[]; issue: CustomerIssueCode | string | null; existing?: boolean }) {
  const reason = requestReason(issue);
  if (!reason || !selections.length) return null;
  return <section className="cp-request-windows"><h3>{existing ? 'Current request window' : 'Request window'} · {requestReasonLabels[reason]}</h3><ul>{selections.map(selection => { const item = data.order.items.find(item => item.id === selection.item_id); const window = item?.request_windows?.find(window => window.reason === reason); return <li key={selection.item_id}><h4>{item?.title || 'Order item'}</h4><WindowDates window={window} /></li>; })}</ul><p className="cp-window-timezone">All request times are shown in UTC.{existing ? ' These dates apply to new requests. Your existing review and requests for additional information can continue.' : ''}</p></section>;
}
