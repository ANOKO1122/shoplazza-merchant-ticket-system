import type { CustomerLocation } from '../../src/protection-customer-types';
type Callbacks = { onSample(value: CustomerLocation): void; onComplete(value: CustomerLocation): void; onError(message: string): void };
type LocationDevice = Pick<Geolocation, 'watchPosition' | 'clearWatch'>;
export type LocationCaptureHandle = { cancel(): void; finish(): void };
const timeoutMessage = 'The location request timed out without a usable reading. Enable location services and try again.';

/** Preserve raw device readings. A smaller reported radius is not proof of real-world accuracy. */
export function startLocationCapture(geo: LocationDevice, callbacks: Callbacks): LocationCaptureHandle {
  const started = Date.now(); let active = true, watch: number | undefined;
  let best: CustomerLocation | null = null; const timestamps = new Set<number>();
  let deadline: ReturnType<typeof setTimeout>, settling: ReturnType<typeof setTimeout>;
  function stop() {
    active = false; clearTimeout(deadline); clearTimeout(settling);
    if (watch !== undefined) { geo.clearWatch(watch); watch = undefined; }
  }
  function finish() { if (!active) return; stop(); if (best) callbacks.onComplete(best); else callbacks.onError(timeoutMessage); }
  function fail(message: string) { if (!active) return; stop(); callbacks.onError(message); }
  function settled() { if (active && best && best.accuracy_meters <= 20 && timestamps.size >= 2 && Date.now() - started >= 5000) finish(); }
  deadline = setTimeout(finish, 20000); settling = setTimeout(settled, 5000);
  try {
    watch = geo.watchPosition(position => {
      if (!active) return;
      const { latitude, longitude, accuracy } = position.coords, time = position.timestamp;
      if (![latitude, longitude, accuracy, time].every(Number.isFinite) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || accuracy < 0 || accuracy > 100000 || time < started - 5000 || time > Date.now() + 10000) return;
      timestamps.add(time);
      if (!best || accuracy <= best.accuracy_meters) {
        best = { latitude, longitude, accuracy_meters: accuracy, captured_at: new Date(time).toISOString() };
        callbacks.onSample(best);
      }
      settled();
    }, error => {
      if (!active) return;
      if (error.code === 1) fail('Allow location permission for this website in your browser and device settings, then try again.');
      else if (best) finish();
      else fail(error.code === 3 ? timeoutMessage : 'Your location could not be determined. Check location services and your connection, then try again.');
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
    // Test doubles and some embedded browsers may return synchronously after invoking an error callback.
    if (!active && watch !== undefined) { geo.clearWatch(watch); watch = undefined; }
  } catch { fail('Your browser could not start location access. Check permissions, or open this secure link in Safari or Chrome.'); }
  return { cancel: stop, finish };
}
