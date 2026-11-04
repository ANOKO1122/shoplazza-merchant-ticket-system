import { useEffect, useRef, useState } from 'react';
import type { CustomerClaim, CustomerClaimInput, CustomerEvidence, CustomerIssueCode, CustomerLocation, CustomerOrderResponse, CustomerSelection } from '../../src/protection-customer-types';
import { request } from './api';
import { issueLabels, issueOptions, money, selectionAmount, validSelections } from './domain';
import { Dialog, ErrorNotice, Icon, ProductImage } from './shared';
import { Uploads } from './Uploads';
import { CameraEvidence, CameraException } from './CameraEvidence';
import { damageEvidenceProblem } from './camera';
import { ServiceDetails } from './ServiceDetails';
import { servicePolicyBasis } from './service-details';
import { blockedWindowItems, ItemRequestWindow, reasonWindowNotice, RequestWindowNotice, SelectedRequestWindows, selectedWindowProblem, type WindowItem } from './RequestWindows';
const stepNames = ['Package', 'Issue', 'Items', 'Details', 'Review'];
export function Wizard({ data, initialItem, onClose, onSubmitted }: { data: CustomerOrderResponse; initialItem?: string; onClose: () => void; onSubmitted: (claim: CustomerClaim) => void }) {
  const [step, setStep] = useState(0);
  const [windowNotice, setWindowNotice] = useState<{ items: WindowItem[]; returnStep: number } | null>(null);
  const [received, setReceived] = useState<boolean | null>(null);
  const [issue, setIssue] = useState<CustomerIssueCode | null>(null);
  const [selections, setSelections] = useState<CustomerSelection[]>(initialItem ? [{ item_id: initialItem, quantity: 1 }] : []);
  const [description, setDescription] = useState('');
  const [cameraException, setCameraException] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<CustomerEvidence[]>([]);
  const [uploadsBlocked, setUploadsBlocked] = useState(false);
  const [location, setLocation] = useState<CustomerLocation | null>(null);
  const [locating, setLocating] = useState(false);
  const [locationNotice, setLocationNotice] = useState('');
  const [error, setError] = useState<Error | string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const errorRegion = useRef<HTMLDivElement>(null);
  const submissionId = useRef(crypto.randomUUID());
  const preserveEvidence = useRef(false);
  const locationRequest = useRef(0);
  const locationRequired = received === false;
  const requiredLocationMessage = 'Share your current location before continuing with a package-not-received request.';
  useEffect(() => { if (!windowNotice) heading.current?.focus(); }, [step, windowNotice]);
  useEffect(() => { if (error) errorRegion.current?.scrollIntoView({ block: 'nearest' }); }, [error]);
  useEffect(() => () => { locationRequest.current++; }, []);
  const selectedItems = data.order.items.filter(item => selections.some(selection => selection.item_id === item.id));
  const amount = selectionAmount(selections, data.order.items, data.order.remaining_amount_cents);
  function showWindowNotice(items: WindowItem[], returnStep: number) { setError(null); setWindowNotice({ items, returnStep }); }
  function chooseIssue(next: CustomerIssueCode) {
    setIssue(next); setError(null);
    const notice = reasonWindowNotice(next, selections, data.order.items);
    if (notice) showWindowNotice(notice.items, notice.returnToItems ? 2 : 1);
  }
  function proceed() {
    if (step === 0 && received == null) { setError('Tell us whether you have received your package.'); return; }
    if (step === 1 && !issue) { setError('Choose the issue that best describes what happened.'); return; }
    if (step === 1 && issue) { const notice = reasonWindowNotice(issue, selections, data.order.items); if (notice) { showWindowNotice(notice.items, notice.returnToItems ? 2 : 1); return; } }
    if (step === 2 && !validSelections(selections, data.order.items)) { setError('Select at least one available item and a valid quantity.'); return; }
    if (step === 2 && (amount == null || amount <= 0)) { setError('The remaining request amount is not available yet. Close this request and refresh your order before trying again.'); return; }
    if (step === 2) { const problem = selectedWindowProblem(issue, selections, data.order.items); if (problem) { showWindowNotice(blockedWindowItems(issue, selections, data.order.items), 2); return; } }
    if (step === 3 && (!description.trim() || uploadsBlocked || locating)) { setError(uploadsBlocked ? 'Retry or remove files that have not finished uploading.' : locating ? 'Wait for the location request to finish, or cancel it and try again.' : 'Describe what happened so the store can review your request.'); return; }
    if (step === 3 && locationRequired && !location) { setError(requiredLocationMessage); return; }
    if (step === 3 && issue === 'damaged') { const problem = damageEvidenceProblem(evidence, cameraException); if (problem) { setError(problem); return; } }
    setError(null); setStep(step + 1);
  }
  function captureLocation() {
    setError(null);
    const sequence = ++locationRequest.current;
    try {
      const geolocation = navigator.geolocation;
      if (!geolocation) { setLocating(false); setLocationNotice('Location is not available in this browser. Open this secure link in Safari or Chrome and allow location access.'); return; }
      setLocating(true); setLocationNotice('');
      geolocation.getCurrentPosition(position => {
        if (sequence !== locationRequest.current) return;
        setLocation({ latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy_meters: position.coords.accuracy, captured_at: new Date(position.timestamp).toISOString() }); setLocating(false); setLocationNotice('Location added to this request.');
      }, error => { if (sequence !== locationRequest.current) return; setLocating(false); setLocationNotice(error.code === 1 ? 'Allow location permission for this website in your browser and device settings, then try again. If your email browser blocks it, open this secure link in Safari or Chrome.' : error.code === 3 ? 'The location request timed out. Check that location services are enabled, then try again.' : 'Your location could not be determined. Check your device location settings and connection, then try again.'); }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
    } catch {
      if (sequence !== locationRequest.current) return;
      setLocating(false); setLocationNotice('Your browser could not start the location request. Check location permissions and try again, or open this secure link in Safari or Chrome.');
    }
  }
  async function submit() {
    if (busyRef.current || received == null || !issue || amount == null || amount <= 0) return;
    if (locationRequired && (!location || locating)) { setStep(3); setError(requiredLocationMessage); return; }
    const timingProblem = selectedWindowProblem(issue, selections, data.order.items); if (timingProblem) { showWindowNotice(blockedWindowItems(issue, selections, data.order.items), 2); return; }
    if (issue === 'damaged') { const problem = damageEvidenceProblem(evidence, cameraException); if (problem) { setError(problem); return; } }
    busyRef.current = true; setBusy(true); setError(null);
    const payload: CustomerClaimInput = { submission_id: submissionId.current, received_package: received, issue_code: issue, selections, description: description.trim(), evidence_ids: evidence.map(item => item.id), location, camera_exception_reason: issue === 'damaged' && cameraException != null ? cameraException.trim() : null };
    try { const response = await request<{ claim: CustomerClaim }>('/claims', { method: 'POST', body: JSON.stringify(payload) }); preserveEvidence.current = true; onSubmitted(response.claim); }
    catch (error) { setError(error as Error); }
    finally { busyRef.current = false; setBusy(false); }
  }
  return <Dialog title={windowNotice ? 'Request window' : 'Request a refund'} onClose={onClose} busy={busy} footer={windowNotice ? <><button className="cp-button" type="button" onClick={() => { setStep(windowNotice.returnStep); setWindowNotice(null); }}>Back</button><button className="cp-button cp-primary" type="button" onClick={onClose}><span>Close</span></button></> : <><button className="cp-button" type="button" disabled={busy} onClick={() => { if (!step) onClose(); else { setStep(step - 1); setError(null); } }}>{step ? 'Back' : 'Cancel'}</button><button className="cp-button cp-primary" type="button" disabled={busy || (step >= 3 && (uploadsBlocked || locating)) || (step === 4 && (amount == null || amount <= 0))} onClick={() => step === 4 ? void submit() : proceed()}><span>{busy ? 'Submitting…' : step === 4 ? 'Submit request' : 'Continue'}</span>{!busy && step !== 4 && <Icon name="arrow" />}</button></>}>
    {windowNotice && <RequestWindowNotice issue={issue} items={windowNotice.items} basis={servicePolicyBasis(data.coverage?.policy_version)} />}
    <div hidden={!!windowNotice}>
    <div className="cp-service-context"><span>Shipping Protection</span><ServiceDetails basis={servicePolicyBasis(data.coverage?.policy_version)} /></div>
    <ol className="cp-stepper" aria-label="Refund request steps">{stepNames.map((name, index) => <li key={name} aria-current={index === step ? 'step' : undefined} className={index <= step ? 'cp-step-active' : ''}><span>{index < step ? <Icon name="check" size={12} /> : index + 1}</span>{name}</li>)}</ol>
    <div className="cp-step" hidden={step !== 0}><h3 ref={step === 0 ? heading : undefined} tabIndex={-1}>Have you received your package?</h3><p>This helps us ask the right questions about your order.</p><div className="cp-options">{[{ value: true, label: 'Yes, I received my package.' }, { value: false, label: 'No, I have not received it.' }].map(option => <label key={String(option.value)} className={received === option.value ? 'cp-option-selected' : ''}><input type="radio" name="received" checked={received === option.value} onChange={() => { setReceived(option.value); setIssue(null); }} /><span>{option.label}</span></label>)}</div></div>
    <div className="cp-step" hidden={step !== 1}><h3 ref={step === 1 ? heading : undefined} tabIndex={-1}>What went wrong?</h3><p>Select the closest match. You can explain more in the next steps.</p><div className="cp-options">{received != null && issueOptions(received).map(option => <label key={option.value} className={issue === option.value ? 'cp-option-selected' : ''}><input type="radio" name="issue" checked={issue === option.value} onChange={() => chooseIssue(option.value)} /><span>{option.label}</span></label>)}</div><p className="cp-outside-service">Incorrect items, changes of mind, and other issues outside the options above are not included in this service.</p></div>
    <div className="cp-step" hidden={step !== 2}><h3 ref={step === 2 ? heading : undefined} tabIndex={-1}>Which items are affected?</h3><p>Choose the items and quantities included in this request. Only items with an open request window can be included.</p><ul className="cp-select-items">{data.order.items.map(item => { const selection = selections.find(selection => selection.item_id === item.id); const unavailable = item.has_active_claim || item.available_quantity < 1; return <li key={item.id} className={selection ? 'cp-item-selected' : ''}><label><input type="checkbox" aria-label={`Include ${item.title}`} disabled={unavailable} checked={!!selection} onChange={event => { const next = event.target.checked ? [...selections, { item_id: item.id, quantity: 1 }] : selections.filter(selection => selection.item_id !== item.id); setSelections(next); if (event.target.checked) { const blocked = blockedWindowItems(issue, [{ item_id: item.id, quantity: 1 }], data.order.items); if (blocked.length) showWindowNotice(blocked, 2); } }} /><ProductImage src={item.image_url} /><span><strong>{item.title}</strong><small>{money(item.amount_cents, data.order.currency)} · Purchased quantity {item.quantity}</small>{!unavailable && <ItemRequestWindow issue={issue} item={item} />}{unavailable && <small>{item.has_active_claim ? 'An active request already includes this item.' : 'No remaining quantity available for a new request.'}</small>}</span></label>{selection && <label className="cp-quantity">Quantity<input type="number" min={1} max={item.available_quantity} value={selection.quantity} onChange={event => setSelections(selections.map(selection => selection.item_id === item.id ? { ...selection, quantity: Number(event.target.value) } : selection))} /></label>}</li>; })}</ul><SelectedRequestWindows data={data} selections={selections} issue={issue} /></div>
    <div className="cp-step" hidden={step !== 3}><h3 ref={step === 3 ? heading : undefined} tabIndex={-1}>Tell us what happened</h3><p>{issue === 'damaged' ? 'Describe the damage, then use the camera below to show the affected item.' : issue === 'delivered_not_received' ? 'Tell us where you checked for your package and whether you contacted the carrier.' : 'Include any details that can help the store review your request.'}</p><label className="cp-field"><span>Issue details</span><textarea value={description} rows={5} maxLength={10000} placeholder="What happened, when did you notice it, and what have you checked?" onChange={event => setDescription(event.target.value)} /></label>
      {issue === 'damaged' ? <><CameraEvidence limits={data.limits} onChange={setEvidence} onBlocked={setUploadsBlocked} preserve={preserveEvidence} disabled={busy} active={!windowNotice && step === 3 && cameraException == null} requireDamaged={cameraException == null} /><CameraException value={cameraException} onChange={setCameraException} disabled={busy} /></> : <Uploads limits={data.limits} onChange={setEvidence} onBlocked={setUploadsBlocked} preserve={preserveEvidence} disabled={busy} />}
      <section className="cp-location"><h3><Icon name="pin" />Share your location <span>{locationRequired ? 'Required' : 'Optional'}</span></h3><p>{locationRequired ? 'Your current location is required to review a package-not-received request. Share it while you are at the delivery address, if possible. It will be reviewed alongside your order and other evidence.' : 'Your current location can help the store review delivery issues.'} It is only collected when you choose to share it and is included only with this request.</p><div className="cp-inline-actions">{!location && <button className="cp-button" type="button" disabled={locating} onClick={captureLocation}><span>{locating ? 'Getting location…' : 'Share current location'}</span></button>}{(location || locating) && <button className="cp-text-button" type="button" onClick={() => { locationRequest.current++; setLocating(false); setLocation(null); setLocationNotice(''); }}><span>{location ? 'Remove location' : 'Cancel location request'}</span></button>}</div><p className="cp-location-status" role="status">{locationNotice || (locationRequired ? 'Location must be included before you can continue or submit this request.' : 'You can continue without sharing your location.')}</p></section>
    </div>
    <div className="cp-step" hidden={step !== 4}><h3 ref={step === 4 ? heading : undefined} tabIndex={-1}>Review your request</h3><p>Check the details before sending them to the store for review.</p><dl className="cp-review-grid"><div><dt>Order</dt><dd>{data.order.order_number}</dd></div><div><dt>Issue</dt><dd>{issue && issueLabels[issue]}</dd></div><div><dt>Package received</dt><dd>{received ? 'Yes' : 'No'}</dd></div><div><dt>Estimated request amount</dt><dd>{money(amount, data.order.currency)}</dd></div></dl><ul className="cp-review-items">{selectedItems.map(item => <li key={item.id}><ProductImage src={item.image_url} /><div>{item.title}<small>Quantity {selections.find(selection => selection.item_id === item.id)?.quantity}</small></div></li>)}</ul><SelectedRequestWindows data={data} selections={selections} issue={issue} /><p className="cp-description">{description}</p>{issue === 'damaged' && cameraException != null && <div className="cp-notice"><strong>Camera access explanation</strong><p>{cameraException}</p><p>Your explanation will be included for manual review.</p></div>}<p className="cp-muted">{evidence.length} attachment{evidence.length === 1 ? '' : 's'} · {location ? 'Location included' : 'Location not included'}</p><div className="cp-notice">Submitting a request does not issue a refund. The store will review the information and confirm the outcome here.</div></div>
    <div ref={errorRegion} className="cp-step-error"><ErrorNotice error={error} /></div>
    </div>
  </Dialog>;
}
