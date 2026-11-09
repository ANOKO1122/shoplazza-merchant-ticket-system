import type { CustomerLocation } from '../../src/protection-customer-types';
export function LocationResult({ value, provisional = false }: { value: CustomerLocation; provisional?: boolean }) {
  return <div className="cp-location-result"><h4>{provisional ? 'Best reading so far' : 'Recorded location'}</h4><dl>
    <div><dt>Latitude</dt><dd>{value.latitude.toFixed(6)}</dd></div><div><dt>Longitude</dt><dd>{value.longitude.toFixed(6)}</dd></div>
    <div><dt>Device-reported accuracy</dt><dd>About {Math.ceil(value.accuracy_meters).toLocaleString('en-US')} m</dd></div>
    <div><dt>Captured at</dt><dd>{new Date(value.captured_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'medium' })}</dd></div>
  </dl><p>This is a device estimate, not a guaranteed distance from your actual position. If the location looks wrong, enable Precise Location and try again.</p></div>;
}
