import type { CustomerCaptureCategory, CustomerEvidence } from '../../src/protection-customer-types';
export const cameraCategories: Array<{ value: CustomerCaptureCategory; label: string; description: string }> = [
  { value: 'damaged_item', label: 'Damaged item', description: 'Show the whole item and take a close-up of the damaged area.' },
  { value: 'outer_packaging', label: 'Outer packaging', description: 'Show the outside of the parcel, including dents, tears or other damage.' },
  { value: 'shipping_label', label: 'Shipping label', description: 'Keep the tracking number and label readable in the photo.' },
  { value: 'additional', label: 'Additional details', description: 'Add another angle or anything else that helps explain the damage.' },
];
export function cameraCategoryLabel(category: CustomerCaptureCategory): string { return cameraCategories.find(item => item.value === category)!.label; }
export function damageEvidenceProblem(evidence: CustomerEvidence[], exception: string | null): string | null {
  if (evidence.some(item => item.kind !== 'image' || item.source !== 'camera' || !item.capture)) return 'For a damaged item, take new photos using the camera on this page.';
  if (exception != null && exception.trim().length < 10) return 'Explain why you cannot use a camera in at least 10 characters.';
  if (exception == null && !evidence.some(item => item.capture?.category === 'damaged_item')) return 'Take at least one photo of the damaged item, or tell us why you cannot use a camera.';
  return null;
}
/** Prevent a late permission response from reviving a camera after its view closed. */
export class CameraStreamGuard {
  private generation = 0;
  private stream: MediaStream | null = null;
  async open(getStream: () => Promise<MediaStream>): Promise<MediaStream | null> {
    this.stop(); const generation = this.generation; const stream = await getStream();
    if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return null; }
    this.stream = stream; return stream;
  }
  stop(): void { this.generation++; this.stream?.getTracks().forEach(track => track.stop()); this.stream = null; }
}
export function cameraError(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  if (['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(name)) return 'Camera access was not allowed. Open Camera permission help above, follow the steps, then choose Open camera again.';
  if (['NotFoundError', 'DevicesNotFoundError', 'OverconstrainedError'].includes(name)) return 'No available camera was found. Try a device with a camera, or tell us that you cannot use one.';
  if (['NotReadableError', 'TrackStartError', 'AbortError'].includes(name)) return 'The camera could not start. Close other apps using it, then try again.';
  return error instanceof Error ? error.message : 'The camera could not start. Try again or tell us that you cannot use one.';
}
