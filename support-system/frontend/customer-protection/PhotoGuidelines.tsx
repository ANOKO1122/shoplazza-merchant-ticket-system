import { useId, useRef, useState } from 'react';

export function PhotoGuidelines() {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const visible = hovered || pinned;
  return <div className="cp-photo-guide" onPointerEnter={event => { if (event.pointerType === 'mouse') setHovered(true); }} onPointerLeave={event => { if (event.pointerType === 'mouse') setHovered(false); }} onKeyDown={event => { if (event.key === 'Escape') { setHovered(false); setPinned(false); trigger.current?.focus(); } }}>
    <button ref={trigger} className="cp-text-button cp-photo-guide-trigger" type="button" aria-expanded={visible} aria-controls={id} onClick={() => setPinned(value => !value)}><span>Photo guidelines</span></button>
    <div className="cp-photo-guide-panel" id={id} role="region" aria-label="Photo guidelines" hidden={!visible}>
      <p>Show the full package and item first, then add close-ups of the damage.</p>
      <div className="cp-photo-guide-image"><img src="/assets/protection-photo-guidelines.png" width="692" height="724" alt="Photo examples: keep the shipping label on the outer box and photograph the entire damaged package; show the whole packaging bag; show the product with its packaging and add close-ups of damage." loading="lazy" /></div>
      <div className="cp-photo-guide-footer"><span>Swipe or scroll the image to read it at full size.</span><button className="cp-text-button" type="button" onClick={() => { setHovered(false); setPinned(false); trigger.current?.focus(); }}>Close guide</button></div>
    </div>
  </div>;
}
