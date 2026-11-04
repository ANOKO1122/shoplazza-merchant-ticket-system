import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { CustomerClaim, CustomerOrderResponse } from '../../src/protection-customer-types';
import { ApiError, exchangeSession, initializeProtectionReference, request, setProtectionReference } from './api';
import { date, money, shipmentLabel, takeAccessToken } from './domain';
import { Badge, ErrorNotice, Icon, ProductImage } from './shared';
import { Wizard } from './Wizard';
import { ClaimDetail } from './ClaimDetail';
import { ServiceDetails } from './ServiceDetails';
import { servicePolicyBasis } from './service-details';
import { canOpenRequest, OrderRequestWindows } from './RequestWindows';
import './styles.css';
let accessToken = takeAccessToken(window.location, window.history);
initializeProtectionReference(!!accessToken);
function App() {
  const [data, setData] = useState<CustomerOrderResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [wizard, setWizard] = useState<{ item?: string } | null>(null);
  const [claim, setClaim] = useState<CustomerClaim | null>(null);
  const [notice, setNotice] = useState('');
  async function load() {
    setLoading(true); setError(null);
    try {
      if (accessToken) { await exchangeSession(accessToken); accessToken = null; }
      const result = await request<CustomerOrderResponse>('/order'); setProtectionReference(result.order.protection_no); setData(result);
    } catch (error) { setError(error as Error); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  function updated(next: CustomerClaim) {
    setClaim(next); setData(previous => previous ? { ...previous, claims: previous.claims.some(item => item.public_no === next.public_no) ? previous.claims.map(item => item.public_no === next.public_no ? next : item) : [next, ...previous.claims] } : previous);
  }
  const requestAvailable = data ? canOpenRequest(data.eligibility) : false;
  const needsLink = error instanceof ApiError && [401, 403].includes(error.status);
  const shipped = !!data?.coverage?.timestamps.shipped_at || !!data?.order.shipments.some(shipment => ['shipped', 'fulfilled', 'finished', 'completed', 'delivered'].includes(shipment.status));
  const completed = !!data?.coverage?.timestamps.completed_at;
  return <><header className="cp-header"><div><a className="cp-brand" href="/protection"><span><Icon name="shield" size={25} /></span>Shipping Protection</a>{data && <span className="cp-store-name">{data.order.store_name}</span>}</div></header>
    <main className="cp-main">{!data ? <section className="cp-access"><span className="cp-access-icon"><Icon name="shield" size={36} /></span><h1>{loading ? 'Opening your protected order' : needsLink ? 'Your order, securely accessed' : 'Open your protected order'}</h1><p>{loading ? 'Please wait while we verify your access.' : needsLink ? 'Use the secure link in your shipping protection email to view your order or request a refund.' : 'We could not load your order. Check your connection, then try again.'}</p>{!loading && <><ErrorNotice error={needsLink ? null : error} />{needsLink ? <p className="cp-muted">Open the secure link from your shipping protection email. Your order details are never shown without a valid link.</p> : <button className="cp-button cp-primary" onClick={() => void load()}>Try again</button>}</>}</section> : <>
      <div className="cp-page-heading"><div><h1>Your protected order</h1><p>View your shipment, request a refund, and follow its review.</p></div><button className="cp-text-button" onClick={() => void load()} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh order'}</button></div><ErrorNotice error={error} />{notice && <div className="cp-notice" role="status">{notice}</div>}
      <section className="cp-order-summary"><div className="cp-order-title"><div><h2>Order {data.order.order_number}</h2><p>Purchased {date(data.order.purchased_at)}</p></div><div className="cp-protection-reference"><Icon name="shield" /><span>Protection reference<strong>{data.order.protection_no}</strong></span></div></div><div className="cp-order-details"><div><h3>Shipping address</h3><p>{[data.order.shipping_address.address1, data.order.shipping_address.address2, [data.order.shipping_address.city, data.order.shipping_address.province, data.order.shipping_address.postal_code].filter(Boolean).join(', '), data.order.shipping_address.country].filter(Boolean).map((line, index) => <span key={index}>{line}<br /></span>)}</p></div><div><div className="cp-service-label"><h3>Shipping protection</h3><ServiceDetails basis={servicePolicyBasis(data.coverage?.policy_version)} /></div><p>{money(data.order.protection_fee_cents, data.order.currency)}</p><span className="cp-muted">Requests for shipping and delivery issues.</span></div></div><ol className="cp-order-progress" aria-label="Order progress recorded by store"><li className="cp-progress-done"><span><Icon name="check" size={15} /></span><strong>Purchased</strong><small>{date(data.order.purchased_at)}</small></li><li className={shipped ? 'cp-progress-done' : ''}><span>{shipped ? <Icon name="check" size={15} /> : <Icon name="package" size={15} />}</span><strong>{shipped ? 'Shipped' : 'Awaiting shipment'}</strong><small>{data.coverage?.timestamps.shipped_at ? date(data.coverage.timestamps.shipped_at) : shipped ? 'Recorded by store' : 'No shipment recorded'}</small></li><li className={completed ? 'cp-progress-done' : ''}><span>{completed ? <Icon name="check" size={15} /> : <Icon name="shield" size={15} />}</span><strong>{completed ? 'Store completion' : 'Completion pending'}</strong><small>{data.coverage?.timestamps.completed_at ? date(data.coverage.timestamps.completed_at) : completed ? 'Date not yet available' : 'Awaiting store update'}</small></li></ol><p className="cp-progress-note">Store completion is not independent confirmation of carrier delivery. You can report a missing package within its request window even if the store marks it complete.</p><OrderRequestWindows data={data} /></section>
      <section className="cp-section"><div className="cp-section-heading"><div><h2>Items & shipment</h2><p>Choose an affected item to start a refund request.</p></div></div>{!!data.order.shipments.length && <div className="cp-shipments">{data.order.shipments.map((shipment, index) => <details key={shipment.id || index}><summary><Icon name="package" /><span className="cp-tracking-heading"><strong>{shipment.carrier || `Shipment ${index + 1}`}</strong><span>{shipment.tracking_numbers.join(' · ') || 'Tracking number not yet available'}</span></span><span className="cp-shipment-status">{shipmentLabel(shipment.status)}</span><span className="cp-tracking-toggle">Tracking details <Icon name="arrow" size={14} /></span></summary><div className="cp-tracking-details"><h3>Items in this shipment</h3>{shipment.item_quantities.length ? <ul>{shipment.item_quantities.map(selection => <li key={selection.item_id}><span>{data.order.items.find(item => item.id === selection.item_id)?.title || 'Order item'}</span><strong>× {selection.quantity}</strong></li>)}</ul> : <p className="cp-muted">The store has not supplied the items for this shipment yet.</p>}<p className="cp-muted">Shipment information is supplied by the store and does not independently confirm that you received the package.</p></div></details>)}</div>}
      {!data.eligibility.can_submit && <div className="cp-notice">{data.eligibility.reason_code === 'request_window' ? 'No request window is currently open. Choose an issue to see its dates. Existing requests remain available below.' : data.eligibility.message || 'This order is not currently available for a new refund request. You can still view existing requests below.'}</div>}
      <ul className="cp-order-items">{data.order.items.map(item => <li key={item.id}><ProductImage src={item.image_url} /><div><h3>{item.title}</h3><p>{money(item.amount_cents, data.order.currency)} <span>· Quantity {item.quantity}</span></p>{item.has_active_claim && <small>An active request includes this item. View it below.</small>}</div><button className="cp-button" disabled={!requestAvailable || item.has_active_claim || item.available_quantity < 1 || loading} onClick={() => { setNotice(''); setWizard({ item: item.id }); }}>Request a refund</button></li>)}</ul>{!data.order.items.length && <p className="cp-empty">Your items are still being synchronized. Refresh the order shortly.</p>}</section>
      <section className="cp-section"><div className="cp-section-heading"><div><h2>Your requests</h2><p>Each request has its own number. Your protection reference stays the same.</p></div>{requestAvailable && <button className="cp-button" disabled={loading} onClick={() => { setNotice(''); setWizard({}); }}>New request</button>}</div>{data.claims.length ? <ul className="cp-claims-list">{data.claims.map(item => <li key={item.public_no}><div><button className="cp-text-button cp-claim-link" onClick={() => setClaim(item)}>{item.public_no}</button><span>{date(item.created_at)} · {money(item.requested_amount_cents, item.currency)}</span></div><Badge status={item.status} /><button className="cp-text-button" onClick={() => setClaim(item)} aria-label={`View request ${item.public_no}`}>View request <Icon name="arrow" size={17} /></button></li>)}</ul> : <p className="cp-empty">No requests yet. If something went wrong, select “Request a refund” above.</p>}</section>
      {wizard && <Wizard data={data} initialItem={wizard.item} onClose={() => setWizard(null)} onSubmitted={next => { setWizard(null); updated(next); setNotice(`Request ${next.public_no} has been submitted. You can follow its review below.`); void load(); }} />}
      {claim && <ClaimDetail key={claim.public_no} claim={claim} data={data} onClose={() => setClaim(null)} onUpdated={next => { updated(next); void load(); }} />}
    </>}</main><footer className="cp-footer"><Icon name="shield" size={17} /><span>Shipping Protection · Requests & review</span></footer></>;
}
const root = document.getElementById('customer-protection-root');
if (root) createRoot(root).render(<App />);
