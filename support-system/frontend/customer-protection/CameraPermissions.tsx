import { useId, useState } from 'react';
function Diagram({ label, mode }: { label: string; mode: 'menu' | 'settings' | 'allow' }) {
  return <div className="cp-permission-diagram" aria-hidden="true"><svg viewBox="0 0 160 62" width="160" height="62" fill="none"><rect x="1" y="1" width="158" height="60" rx="8" fill="#fff" stroke="#c9d8e4"/><rect x="10" y="10" width="140" height="16" rx="4" fill="#eef4f9"/>{mode === 'menu' ? <><path d="M19 15h10m-10 5h7" stroke="#135fa8" strokeWidth="2"/><path d="M18 40h58m-58 8h93" stroke="#b5c8d8" strokeWidth="3"/></> : mode === 'settings' ? <><path d="M18 39h70m-70 10h47" stroke="#6a8aa4" strokeWidth="3"/><rect x="108" y="35" width="30" height="17" rx="4" fill="#e5f1fb"/><path d="m118 40 5 4-5 4" stroke="#135fa8" strokeWidth="2"/></> : <><path d="M18 43h63" stroke="#6a8aa4" strokeWidth="3"/><rect x="106" y="34" width="34" height="19" rx="10" fill="#135fa8"/><circle cx="130" cy="43.5" r="6.5" fill="#fff"/></>}</svg><span>{label}</span></div>;
}
export function CameraPermissions({ expanded = false }: { expanded?: boolean }) {
  const [device, setDevice] = useState<'ios' | 'android'>('ios');
  const [browser, setBrowser] = useState<'safari' | 'chrome'>('safari'); const id = useId();
  const steps = device === 'android' ? [
    { label: 'Chrome menu', mode: 'menu' as const, text: 'Open Chrome’s More menu, then Settings.' },
    { label: 'Site settings → Camera', mode: 'settings' as const, text: 'Choose Site settings, then Camera.' },
    { label: 'This site → Allow', mode: 'allow' as const, text: 'If this site is blocked, select it and allow camera access. Return here and open the camera again.' },
  ] : browser === 'safari' ? [
    { label: 'Page Menu', mode: 'menu' as const, text: 'In Safari, open Page Menu beside the address bar.' },
    { label: 'Website Settings', mode: 'settings' as const, text: 'Choose Website Settings, or More to find this site’s settings.' },
    { label: 'Camera → Allow', mode: 'allow' as const, text: 'Set Camera to Allow or Ask for this site. Return here and open the camera again.' },
  ] : [
    { label: 'Camera icon', mode: 'menu' as const, text: 'If a camera icon appears beside the address bar in Chrome, tap it.' },
    { label: 'Camera permissions', mode: 'settings' as const, text: 'Turn camera permissions on for this site.' },
    { label: 'Return to your request', mode: 'allow' as const, text: 'Return here and open the camera again. Allow the camera when your browser asks.' },
  ];
  return <details className="cp-camera-help" open={expanded || undefined}><summary>Camera permission help</summary><div className="cp-permission-tabs" role="tablist" aria-label="Device instructions">{([{ key: 'ios', label: 'iPhone / iPad' }, { key: 'android', label: 'Android' }] as const).map(item => <button key={item.key} type="button" role="tab" id={`${id}-${item.key}`} aria-selected={device === item.key} aria-controls={`${id}-panel`} className={device === item.key ? 'cp-permission-active' : ''} onClick={() => setDevice(item.key)}>{item.label}</button>)}</div><div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${device}`}>
    {device === 'ios' && <div className="cp-camera-browser" aria-label="Browser"><button type="button" aria-pressed={browser === 'safari'} onClick={() => setBrowser('safari')}>Safari</button><button type="button" aria-pressed={browser === 'chrome'} onClick={() => setBrowser('chrome')}>Chrome on iPhone</button></div>}
    <ol className="cp-permission-steps">{steps.map((step, index) => <li key={step.label}><Diagram label={step.label} mode={step.mode} /><p><strong>{index + 1}.</strong> {step.text}</p></li>)}</ol>
    <p className="cp-muted">{device === 'android' ? 'If Chrome says sites cannot ask for the camera, turn on “Sites can ask”, then allow this site. Android’s app permissions may also need Camera enabled for Chrome.' : browser === 'chrome' ? 'If iPhone blocks Chrome itself, open Settings → Apps → Chrome → Camera and turn it on. Older iOS versions list Chrome directly in Settings.' : 'If the camera is unavailable in an email app’s browser, open this secure link in Safari.'} Menu names can vary by browser version.</p><p className="cp-muted">Only the camera is used. You do not need to grant microphone access.</p>
  </div></details>;
}
