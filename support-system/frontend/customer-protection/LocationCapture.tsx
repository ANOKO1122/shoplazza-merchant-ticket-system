import { useEffect, useRef, useState } from 'react';
import type { CustomerLocation } from '../../src/protection-customer-types';
import { Icon } from './shared';
import { LocationPermissions } from './LocationPermissions';
import { startLocationCapture, type LocationCaptureHandle } from './location';
import './location.css';
import { LocationResult } from './LocationResult';


export function LocationCapture({ value, onChange, onBusy, required, active }: { value: CustomerLocation | null; onChange: (value: CustomerLocation | null) => void; onBusy: (busy: boolean) => void; required: boolean; active: boolean }) {
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [help, setHelp] = useState(false);
  const capture = useRef<LocationCaptureHandle | null>(null);
  const busyRef = useRef(false);
  function cancel() { capture.current?.cancel(); capture.current = null; busyRef.current = false; setBusy(false); onBusy(false); }
  useEffect(() => { if (!active) cancel(); return () => { capture.current?.cancel(); capture.current = null; }; }, [active]);
  useEffect(() => {
    const hidden = () => { if (document.hidden && busyRef.current) { cancel(); setNotice('Location capture stopped when you left this page. Try again when you are ready.'); } };
    document.addEventListener('visibilitychange', hidden);
    return () => document.removeEventListener('visibilitychange', hidden);
  }, []);
  function begin() {
    cancel(); onChange(null); setNotice(''); setHelp(false);
    try {
      const device = navigator.geolocation;
      if (!device) throw new Error('unavailable');
      busyRef.current = true; setBusy(true); onBusy(true);
      capture.current = startLocationCapture(device, {
        onComplete: location => { busyRef.current = false; setBusy(false); onBusy(false); onChange(location); setNotice('Location added to this request.'); },
        onError: message => { busyRef.current = false; setBusy(false); onBusy(false); setNotice(message); setHelp(true); },
      });
    } catch { setBusy(false); onBusy(false); setNotice('Location is not available in this browser. Open this secure link in Safari or Chrome and allow location access.'); setHelp(true); }
  }
  return <section className="cp-location"><h3><Icon name="pin" /><span>Share your location</span><span>{required ? 'Required' : 'Optional'}</span></h3>
    <p>{required ? 'Your current location is required to review a package-not-received request. Share it at the delivery address, if possible.' : 'Your current location can help the store review delivery issues.'} It is collected only when you choose to share it, and sent only when you submit this request.</p>
    <LocationPermissions expanded={help} onRetry={begin} busy={busy} />
    {value && <LocationResult value={value} />}
    <div className="cp-inline-actions">{!busy && <button className="cp-button" type="button" onClick={begin}><span>{value ? 'Try again for a better location' : 'Share current location'}</span></button>}
      {busy && <button className="cp-text-button" type="button" onClick={() => { cancel(); setNotice('Location request cancelled.'); }}><span>Cancel location request</span></button>}
      {!busy && value && <button className="cp-text-button" type="button" onClick={() => { onChange(null); setNotice(''); }}><span>Remove location</span></button>}
    </div><p className="cp-location-status" role="status">{busy ? 'Getting your location… You can continue as soon as it is available. After you allow access, finding a location can take up to 8 seconds.' : notice || (required ? 'Location must be included before you can continue or submit this request.' : 'You can continue without sharing your location.')}</p>
  </section>;
}
