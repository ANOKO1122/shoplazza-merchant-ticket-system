import { useRef } from 'react';
import { EvidenceQueueList, useEvidenceQueue, type EvidenceQueueProps } from './EvidenceQueue';
import { ErrorNotice, Icon } from './shared';
export function Uploads(props: EvidenceQueueProps) {
  const queue = useEvidenceQueue(props); const input = useRef<HTMLInputElement>(null);
  return <div className="cp-uploads"><div className="cp-upload-heading"><div><h3>Photos & videos</h3><p>Show the item, packaging, shipping label, or other details that help explain the issue.</p></div><button className="cp-button" type="button" disabled={props.disabled} onClick={() => input.current?.click()}><Icon name="upload" />Add files</button></div>
    <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/webm" multiple hidden disabled={props.disabled} onChange={event => { if (event.target.files) queue.add(Array.from(event.target.files).map(file => ({ file }))); event.target.value = ''; }} />
    <p className="cp-muted">JPEG, PNG, WebP, MP4 or WebM · Up to {props.limits.max_files} files · {Math.floor(props.limits.max_file_bytes / 1024 / 1024)} MB per file. Do not include payment card details or identity documents.</p><ErrorNotice error={queue.error} />
    <EvidenceQueueList queue={queue} disabled={props.disabled} />
  </div>;
}
