// Customer portal presentation. The Shoplazza app is a separate local package.
export type ServicePolicyBasis = 'shipment' | 'completion';
export interface ServiceIssue { key: 'damaged' | 'lost' | 'stolen' | 'delayed'; title: string; description: string; }
export const serviceDetails = Object.freeze<{ title: string; introduction: string; issues: ServiceIssue[]; completionNote: string; footer: string }>({
  title: 'Shipping Protection',
  introduction: 'Shipping Protection helps with these shipping and delivery issues. With sufficient evidence and an approved request, you may receive a full or partial refund for affected items:',
  issues: [
    { key: 'damaged', title: 'Damage', description: 'An item is damaged during shipping or delivery.' },
    { key: 'lost', title: 'Loss', description: 'Your package has not arrived, or items are missing from it.' },
    { key: 'stolen', title: 'Theft', description: 'Your order is marked complete, but your package cannot be found.' },
    { key: 'delayed', title: 'Delay', description: 'Your shipment is significantly delayed.' },
  ],
  completionNote: 'Store completion is a status recorded by the store. It does not confirm that you received the package.',
  footer: 'The store reviews each request and decides any refund amount. Approval does not mean funds have already been sent. Other product issues are outside this service.',
});

export function serviceWindowRules(basis?: ServicePolicyBasis): Partial<Record<ServiceIssue['key'], string>> {
  if (basis !== 'shipment' && basis !== 'completion') return {};
  const start = basis === 'completion' ? 'the store marks your order complete' : 'your item ships';
  return {
    damaged: 'Request within 7 days after the store marks your order complete.',
    stolen: 'Request within 7 days after the store marks your order complete.',
    delayed: `Request from 30 days after ${start}, no later than 90 days after the order date.`,
    lost: `Request from 60 days after ${start}, no later than 90 days after the order date.`,
  };
}

export function servicePolicyBasis(version?: string): ServicePolicyBasis | undefined {
  const basis = typeof version === 'string' ? version.match(/(?:^|[-_:])(shipment|completion)$/)?.[1] : undefined;
  return basis === 'shipment' || basis === 'completion' ? basis : undefined;
}

export function popoverPosition(anchor: { top: number; right: number; bottom: number }, panel: { height: number }, viewport: { width: number; height: number }) {
  const gap = 8, edge = 12;
  const width = Math.min(360, Math.max(0, viewport.width - edge * 2));
  const availableAbove = Math.max(0, Math.min(viewport.height - edge * 2, anchor.top - gap - edge));
  const availableBelow = Math.max(0, Math.min(viewport.height - edge * 2, viewport.height - edge - anchor.bottom - gap));
  const placeBelow = panel.height <= availableBelow || availableBelow >= availableAbove;
  const maxHeight = placeBelow ? availableBelow : availableAbove;
  const height = Math.min(panel.height, maxHeight);
  const top = placeBelow ? Math.max(edge, anchor.bottom + gap) : Math.max(edge, anchor.top - height - gap);
  return { width, maxHeight, left: Math.max(edge, Math.min(anchor.right - width, viewport.width - edge - width)), top };
}

// Hover and focus reveal; click pins. Escape/outside click always dismiss.
export function attachInfoPopover(button: HTMLButtonElement, panel: HTMLDivElement): () => void {
  const document = button.ownerDocument, window = document.defaultView;
  if (!window) return () => {};
  let timer: number | undefined;
  let opened = false, pinned = false, pointerFocus = false, suppressFocus = false;
  const native = typeof panel.showPopover === 'function';
  panel.setAttribute('popover', 'manual');
  panel.hidden = true;
  const position = () => {
    if (!opened) return;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    panel.style.width = Math.min(360, viewport.width - 24) + 'px';
    const next = popoverPosition(button.getBoundingClientRect(), { height: panel.scrollHeight }, viewport);
    Object.assign(panel.style, { width: next.width + 'px', maxHeight: next.maxHeight + 'px', left: next.left + 'px', top: next.top + 'px' });
  };
  const close = (restore = false) => {
    clearTimeout(timer); pinned = false; opened = false;
    if (native && panel.matches(':popover-open')) panel.hidePopover();
    panel.hidden = true; button.setAttribute('aria-expanded', 'false');
    if (restore) { suppressFocus = true; button.focus(); suppressFocus = false; }
  };
  const open = () => {
    clearTimeout(timer);
    if (opened || !button.isConnected) return;
    opened = true; panel.hidden = false;
    if (native) panel.showPopover();
    button.setAttribute('aria-expanded', 'true'); position();
  };
  const leave = () => { clearTimeout(timer); timer = window.setTimeout(() => { if (!pinned && !panel.contains(document.activeElement) && document.activeElement !== button) close(); }, 140); };
  const enter = (event: Event) => { if ((event as PointerEvent).pointerType !== 'touch') open(); };
  const focus = () => { if (!pointerFocus && !suppressFocus) open(); };
  const pointerDown = () => { pointerFocus = true; window.setTimeout(() => { pointerFocus = false; }, 0); };
  const click = (event: Event) => { event.preventDefault(); event.stopPropagation(); if (opened && pinned) close(); else { open(); pinned = true; } };
  const outside = (event: Event) => { if (!button.contains(event.target as Node | null) && !panel.contains(event.target as Node | null)) close(); };
  const key = (event: Event) => { if (opened && (event as KeyboardEvent).key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(panel.contains(document.activeElement)); } };
  const blur = () => { window.setTimeout(() => { if (!button.contains(document.activeElement) && !panel.contains(document.activeElement)) close(); }, 0); };
  const closeButton = panel.querySelector('[data-sp-info-close]');
  const closeClick = () => close(true);
  const scroll = () => { if (opened && (!button.isConnected || button.closest('[hidden]'))) close(); else position(); };
  const listeners: Array<[EventTarget, string, EventListener]> = [[button, 'pointerenter', enter], [button, 'pointerleave', leave], [button, 'pointerdown', pointerDown], [button, 'focus', focus], [button, 'blur', blur], [button, 'click', click], [panel, 'pointerenter', open], [panel, 'pointerleave', leave], [panel, 'focusout', blur], [document, 'pointerdown', outside], [document, 'keydown', key], [window, 'resize', position]];
  for (const [target, event, handler] of listeners) target.addEventListener(event, handler);
  document.addEventListener('scroll', scroll, true);
  closeButton?.addEventListener('click', closeClick);
  return () => { close(); for (const [target, event, handler] of listeners) target.removeEventListener(event, handler); document.removeEventListener('scroll', scroll, true); closeButton?.removeEventListener('click', closeClick); };
}
