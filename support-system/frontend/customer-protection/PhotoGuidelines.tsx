import { useId, useRef, useState } from 'react';

export function PhotoGuidelines() {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const visible = hovered || pinned;
  return <div className="cp-photo-guide" onKeyDown={event => { if (event.key === 'Escape') { setHovered(false); setPinned(false); trigger.current?.focus(); } }}>
    <button ref={trigger} className="cp-text-button cp-photo-guide-trigger" type="button" aria-expanded={visible} aria-controls={id} onPointerEnter={event => { if (event.pointerType === 'mouse') setHovered(true); }} onPointerLeave={event => { if (event.pointerType === 'mouse' && !(event.relatedTarget instanceof Node && panel.current?.contains(event.relatedTarget))) setHovered(false); }} onClick={() => setPinned(value => !value)}><span>Photo guidelines</span></button>
    <div ref={panel} className="cp-photo-guide-panel" id={id} role="region" aria-label="Photo guidelines" hidden={!visible} onPointerLeave={event => { if (event.pointerType === 'mouse') setHovered(false); }}>
      <p>Show the full package and item first, then add close-ups of the damage.</p>
      <div className="cp-photo-guide-image"><img src="/assets/protection-photo-guidelines.png" width="692" height="724" alt="Photo examples: keep the shipping label on the outer box and photograph the entire damaged package; show the whole packaging bag; show the product with its packaging and add close-ups of damage." loading="lazy" /></div>
      <div className="cp-photo-guide-footer"><a className="cp-text-button" href="/assets/protection-photo-guidelines.png" target="_blank" rel="noopener noreferrer">Open full-size image</a><a className="cp-text-button" href="/protection/photo-requirements" target="_blank" rel="noopener noreferrer">Read photo checklist</a><button className="cp-text-button" type="button" onClick={() => { setHovered(false); setPinned(false); trigger.current?.focus(); }}>Close guide</button></div>
    </div>
  </div>;
}
