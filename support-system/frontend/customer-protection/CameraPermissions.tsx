import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

type Device = 'ios' | 'android';
const devices = [{ key: 'ios', label: 'iOS' }, { key: 'android', label: 'Android' }] as const;

export function CameraPermissions({ expanded = false }: { expanded?: boolean }) {
  const id = useId();
  const [device, setDevice] = useState<Device>('ios');
  const [open, setOpen] = useState(expanded);
  const [zoomed, setZoomed] = useState(false);
  const tabs = useRef<Partial<Record<Device, HTMLButtonElement>>>({});
  useEffect(() => { if (typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)) setDevice('android'); }, []);
  useEffect(() => { if (expanded) setOpen(true); }, [expanded]);
  function selectDevice(next: Device) { setDevice(next); setZoomed(false); }
  function moveTab(event: KeyboardEvent<HTMLButtonElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next: Device = event.key === 'Home' ? 'ios' : event.key === 'End' ? 'android' : device === 'ios' ? 'android' : 'ios';
    selectDevice(next); tabs.current[next]?.focus();
  }
  return <details className="cp-camera-help" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Camera permission help</summary>
    <div className="cp-camera-help-content">
      <p className="cp-muted">If your browser asks for camera access, use the steps for your phone below. A phone camera picker may use different permissions.</p>
      <div className="cp-camera-guide-toolbar">
        <div className="cp-permission-tabs" role="tablist" aria-label="Camera instructions by device">
          {devices.map(item => <button key={item.key} ref={element => { if (element) tabs.current[item.key] = element; }} type="button" role="tab" id={`${id}-${item.key}`} aria-controls={`${id}-panel`} aria-selected={device === item.key} tabIndex={device === item.key ? 0 : -1} className={device === item.key ? 'cp-permission-active' : ''} onClick={() => selectDevice(item.key)} onKeyDown={moveTab}>{item.label}</button>)}
        </div>
        <button className="cp-button cp-camera-zoom" type="button" aria-expanded={zoomed} aria-controls={`${id}-image`} onClick={() => setZoomed(value => !value)}>{zoomed ? 'Fit image' : 'Enlarge image'}</button>
      </div>
      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${device}`}>
        <div id={`${id}-image`} className={`cp-camera-guide-image${zoomed ? ' cp-camera-guide-zoomed' : ''}`} tabIndex={zoomed ? 0 : undefined} role={zoomed ? 'region' : undefined} aria-label={zoomed ? 'Enlarged camera guide. Scroll horizontally to view all steps.' : undefined}>
          <img src="/assets/protection-camera-ios.png" width="1304" height="423" alt="iPhone Chrome: open Settings, Apps, Chrome, Camera, then turn camera access on." hidden={device !== 'ios'} loading="lazy" />
          <img src="/assets/protection-camera-android.png" width="1230" height="397" alt="Android Chrome: open Chrome Settings, Site settings, Camera, then allow websites to request camera access." hidden={device !== 'android'} loading="lazy" />
        </div>
        {zoomed && <p className="cp-muted">Swipe or scroll sideways to view the full guide.</p>}
        {device === 'ios' ? <p className="cp-muted">On iPhone, allow Chrome to use the camera in Settings → Apps → Chrome → Camera. If you use Safari, check its Website Settings for this site instead.</p> : <p className="cp-muted">On Android, allow camera requests in Chrome → Settings → Site settings → Camera. Check Android app permissions for Chrome if access is still blocked.</p>}
        <p className="cp-muted">Menu names may vary by phone and browser version. You do not need to grant microphone access.</p>
      </div>
    </div>
  </details>;
}
