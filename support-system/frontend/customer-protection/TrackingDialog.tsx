import { useEffect, useRef, useState } from 'react';
import { Icon } from './shared';
import { trackingWidgetUrl } from './tracking-widget';

export function TrackingDialog({ numbers, onClose }: { numbers: string[]; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const openedAt = useRef(Date.now());
  const [selected, setSelected] = useState(numbers[0]);
  useEffect(() => {
    dialog.current?.showModal();
    return () => { if (dialog.current?.open) dialog.current.close(); };
  }, []);
  const language = typeof navigator === 'undefined' ? 'en' : navigator.language;
  return <dialog ref={dialog} className="cp-dialog cp-tracking-dialog" aria-labelledby="cp-tracking-title" onClose={onClose}>
    <div className="cp-dialog-heading"><h2 id="cp-tracking-title">Tracking details</h2><button type="button" className="cp-icon-button" aria-label="Close tracking details" onClick={() => dialog.current?.close()}><Icon name="close" size={20} /></button></div>
    <div className="cp-tracking-body">
      {numbers.length > 1 ? <label className="cp-tracking-selector">Tracking number<select value={selected} onChange={event => setSelected(event.target.value)}>{numbers.map(number => <option key={number} value={number}>{number}</option>)}</select></label> : <p className="cp-tracking-number">Tracking number <strong>{selected}</strong></p>}
      <iframe key={selected} className="cp-tracking-frame" title={`17TRACK results for ${selected}`} src={trackingWidgetUrl(selected, language, openedAt.current)} sandbox="allow-scripts allow-forms allow-popups allow-same-origin" referrerPolicy="no-referrer" />
      <p className="cp-muted">Tracking updates are provided by 17TRACK and may take time to appear.</p>
    </div>
  </dialog>;
}
