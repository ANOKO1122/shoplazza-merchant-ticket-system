import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import './location-permissions.css';

type Device = 'ios' | 'android';
const devices = [
  { key: 'ios', label: 'iOS' },
  { key: 'android', label: 'Android' },
] as const;

export function LocationPermissions({ expanded = false, onRetry, busy = false }: {
  expanded?: boolean;
  onRetry?: () => void;
  busy?: boolean;
}) {
  const id = useId();
  const [device, setDevice] = useState<Device>('ios');
  const [open, setOpen] = useState(expanded);
  const [zoomed, setZoomed] = useState(false);
  const tabs = useRef<Partial<Record<Device, HTMLButtonElement>>>({});

  useEffect(() => {
    if (typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)) setDevice('android');
  }, []);
  useEffect(() => { if (expanded) setOpen(true); }, [expanded]);

  function selectDevice(next: Device) {
    setDevice(next);
    setZoomed(false);
  }
  function moveTab(event: KeyboardEvent<HTMLButtonElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next: Device = event.key === 'Home' ? 'ios' : event.key === 'End' ? 'android' : device === 'ios' ? 'android' : 'ios';
    selectDevice(next);
    tabs.current[next]?.focus();
  }

  return <details className="cp-location-help" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Help with location access</summary>
    <div className="cp-location-help-content">
      <p>Allow location access for your browser and this website. Enable precise location when available.</p>
      <div className="cp-guide-frame">
          <div className="cp-guide-toolbar">
            <div className="cp-guide-tabs" role="tablist" aria-label="Location instructions by device">
              {devices.map(item => <button key={item.key} ref={element => { if (element) tabs.current[item.key] = element; }} type="button" role="tab" id={`${id}-${item.key}`} aria-selected={device === item.key} aria-controls={`${id}-panel`} tabIndex={device === item.key ? 0 : -1} onClick={() => selectDevice(item.key)} onKeyDown={moveTab}><span>{item.label}</span></button>)}
            </div>
            <button type="button" className="cp-guide-image-toggle" aria-expanded={zoomed} aria-controls={`${id}-image`} aria-label={zoomed ? 'Fit image' : 'Enlarge image'} title={zoomed ? 'Fit image' : 'Enlarge image'} onClick={() => setZoomed(value => !value)}>
              <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={zoomed ? 'M9 3v6H3m18 0h-6V3M3 15h6v6m6 0v-6h6' : 'M3 9V3h6m6 0h6v6M3 15v6h6m6 0h6v-6'} /></svg>
            </button>
          </div>
          <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${device}`}>
            <div id={`${id}-image`} className={`cp-guide-image cp-location-guide-image${zoomed ? ' cp-guide-zoomed' : ''}`} tabIndex={zoomed ? 0 : undefined} role={zoomed ? 'region' : undefined} aria-label={zoomed ? 'Enlarged location guide. Scroll horizontally to view all steps.' : undefined}>
              <img src={`/assets/protection-location-${device}.png`} width={device === 'ios' ? 1335 : 1340} height={device === 'ios' ? 439 : 493} alt={device === 'ios' ? 'iPhone Chrome location guide: Settings, Apps, Chrome, Location, While Using the App.' : 'Android Chrome location guide: browser Settings, Site settings, Location, allow location access.'} loading="lazy" />
            </div>
          </div>
      </div>
        {zoomed && <p className="cp-location-help-caption">Swipe or scroll sideways to view the full guide.</p>}
        <p className="cp-location-help-caption">The illustrations show Chrome. Menu names may differ by device or browser version.</p>
        {device === 'ios' ? <ol key="ios" className="cp-location-help-steps">
          <li>Open <strong>Settings → Privacy &amp; Security → Location Services</strong> and turn Location Services on.</li>
          <li>Select your browser, or <strong>Safari Websites</strong> for Safari. Allow access while using the app and turn on <strong>Precise Location</strong> when shown. For Chrome, you can also find Location under Settings → Apps → Chrome.</li>
          <li>Return to this page and try again. Choose <strong>Allow</strong> when the browser asks to share your location. If you previously blocked this website, change its location permission in the browser’s website settings first.</li>
        </ol> : <ol key="android" className="cp-location-help-steps">
          <li>Turn on your phone’s <strong>Location</strong>. Touch and hold your browser’s app icon, then open <strong>App info → Permissions → Location</strong>. Choose <strong>Allow only while using the app</strong> and enable <strong>Use precise location</strong> when shown.</li>
          <li>In Chrome, open <strong>More → Settings → Site settings → Location</strong>. Allow sites to request your location. If this website is blocked, change its permission to <strong>Allow</strong>.</li>
          <li>Return to this page and try again. Choose <strong>Allow</strong> when asked. If a precise or approximate choice appears, select <strong>Precise</strong>.</li>
        </ol>}
      <p className="cp-location-help-tip">For a better reading, stay still near an open window or outdoors if safe. Keep this page open while your device finds your location.</p>
      <p className="cp-location-help-caption">If you opened the link inside an email app, open the same secure link in Safari or Chrome and allow location there.</p>
      {onRetry && <button type="button" className="cp-button cp-location-retry" disabled={busy} onClick={onRetry}><span>{busy ? 'Finding your location…' : 'Try location again'}</span></button>}
    </div>
  </details>;
}
