import { useRef, useState } from 'react';
import type { CustomerClaim, CustomerEvidence, CustomerOrderResponse } from '../../src/protection-customer-types';
import { request } from './api';
import { date, issueLabels, money } from './domain';
import { Badge, Dialog, ErrorNotice, EvidenceList, ProductImage } from './shared';
import { Uploads } from './Uploads';
import { CameraEvidence } from './CameraEvidence';
import { ServiceDetails } from './ServiceDetails';
import { servicePolicyBasis } from './service-details';
import { SelectedRequestWindows } from './RequestWindows';
export function ClaimDetail({ claim, data, onClose, onUpdated }: { claim: CustomerClaim; data: CustomerOrderResponse; onClose: () => void; onUpdated: (claim: CustomerClaim) => void }) {
  const [description, setDescription] = useState('');
  const [evidence, setEvidence] = useState<CustomerEvidence[]>([]);
  const [uploadsBlocked, setUploadsBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<Error | string | null>(null);
  const [sent, setSent] = useState(false);
  const [uploadScope, setUploadScope] = useState({ generation: 0, preserve: { current: false } });
  const submissionId = useRef(crypto.randomUUID());
  const damaged = claim.issue_code === 'damaged' || claim.reason === 'damaged';
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busyRef.current || uploadsBlocked) return;
    if (!description.trim()) { setError('Describe the additional information you want the store to review.'); return; }
    busyRef.current = true; setBusy(true); setError(null);
    try {
      const response = await request<{ claim: CustomerClaim }>(`/claims/${encodeURIComponent(claim.public_no)}/messages`, { method: 'POST', body: JSON.stringify({ submission_id: submissionId.current, description: description.trim(), evidence_ids: evidence.map(item => item.id) }) });
      uploadScope.preserve.current = true; setUploadScope(previous => ({ generation: previous.generation + 1, preserve: { current: false } })); setEvidence([]); setUploadsBlocked(false); submissionId.current = crypto.randomUUID(); setSent(true); setDescription(''); onUpdated(response.claim);
    } catch (error) { setError(error as Error); }
    finally { busyRef.current = false; setBusy(false); }
  }
  return <Dialog title={`Request ${claim.public_no}`} onClose={onClose} busy={busy} footer={<button className="cp-button" onClick={onClose} disabled={busy}>Back to order</button>}>
    <div className="cp-claim-heading"><Badge status={claim.status} /><span className="cp-muted">Submitted {date(claim.created_at)}</span></div>
    <div className="cp-service-context"><span>Shipping Protection</span><ServiceDetails basis={servicePolicyBasis(data.coverage?.policy_version)} /></div>
    <dl className="cp-review-grid"><div><dt>Protection reference</dt><dd>{claim.protection_no}</dd></div><div><dt>Requested amount</dt><dd>{money(claim.requested_amount_cents, claim.currency)}</dd></div><div><dt>Issue</dt><dd>{claim.issue_code ? issueLabels[claim.issue_code] : claim.reason}</dd></div>{claim.approved_amount_cents != null && <div><dt>Approved amount</dt><dd>{money(claim.approved_amount_cents, claim.currency)}</dd></div>}</dl>
    <SelectedRequestWindows data={data} selections={claim.selections} issue={claim.issue_code || claim.reason} existing />
    {claim.customer_message && <section className="cp-public-message"><h3>Message from the store</h3><p>{claim.customer_message}</p></section>}
    {claim.status === 'approved' && <p className="cp-notice">Your request has been approved. Refunds are handled separately by the store; approval alone does not confirm that funds have been sent.</p>}
    {claim.status === 'closed' && <p className="cp-notice">The store has recorded that this request was handled outside this portal.</p>}
    {claim.status === 'rejected' && <p className="cp-notice">You can submit a new request while the relevant request window is open and the affected items remain eligible. Your protection reference stays the same.</p>}
    {claim.camera_exception_reason && <section className="cp-public-message"><h3>Camera access explanation</h3><p>{claim.camera_exception_reason}</p><p className="cp-muted">This explanation is included for manual review.</p></section>}
    <section className="cp-detail-section"><h3>Items in this request</h3><ul className="cp-review-items">{claim.selections.map(selection => { const item = data.order.items.find(item => item.id === selection.item_id); return <li key={selection.item_id}><ProductImage src={item?.image_url || null} /><div>{item?.title || 'Order item'}<small>Quantity {selection.quantity}</small></div></li>; })}</ul></section>
    <section className="cp-detail-section"><h3>Your description</h3><p className="cp-description">{claim.description}</p><EvidenceList files={claim.evidence} /><p className="cp-muted">{claim.location ? 'Your shared location is included with this request.' : 'No location was included.'}</p></section>
    {!!claim.messages.length && <section className="cp-detail-section"><h3>Additional information</h3><ol className="cp-message-history">{claim.messages.map(message => <li key={message.id}><time>{date(message.created_at)}</time><p>{message.description}</p><EvidenceList files={message.evidence} /></li>)}</ol></section>}
    {['submitted', 'reviewing', 'needs_info'].includes(claim.status) && <form className="cp-supplement" onSubmit={submit}><h3>{claim.status === 'needs_info' ? 'Send the requested information' : 'Add information to your request'}</h3><label className="cp-field"><span>Additional details</span><textarea value={description} onChange={event => { setDescription(event.target.value); setSent(false); }} maxLength={10000} rows={4} required disabled={busy} /></label>{damaged ? <CameraEvidence key={uploadScope.generation} limits={data.limits} onChange={setEvidence} onBlocked={setUploadsBlocked} preserve={uploadScope.preserve} disabled={busy} active={!busy} /> : <Uploads key={uploadScope.generation} limits={data.limits} onChange={setEvidence} onBlocked={setUploadsBlocked} preserve={uploadScope.preserve} disabled={busy} />}<ErrorNotice error={error} /><button className="cp-button cp-primary" type="submit" disabled={busy || uploadsBlocked}>{busy ? 'Sending…' : 'Send information'}</button></form>}
    {sent && <p className="cp-notice" role="status">Your information has been added to this request.</p>}
  </Dialog>;
}
