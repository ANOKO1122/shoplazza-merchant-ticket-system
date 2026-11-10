import type { CustomerLocation } from '../../src/protection-customer-types';
type Callbacks = { onComplete(value: CustomerLocation): void; onError(message: string): void };
type LocationDevice = Pick<Geolocation, 'watchPosition' | 'clearWatch'>;
export type LocationCaptureHandle = { cancel(): void };
const timeoutMessage = 'The location request timed out without a usable reading. Permission alone does not provide a position. Try again near a window or outdoors if safe.';

/** Preserve raw device readings. A smaller reported radius is not proof of real-world accuracy. */
export function startLocationCapture(geo: LocationDevice, callbacks: Callbacks): LocationCaptureHandle {
  const started = Date.now(); let active = true, watch: number | undefined;
  function stop() {
    active = false;
    if (watch !== undefined) { geo.clearWatch(watch); watch = undefined; }
  }
  function fail(message: string) { if (!active) return; stop(); callbacks.onError(message); }
  try {
    watch = geo.watchPosition(position => {
      if (!active) return;
      const { latitude, longitude, accuracy } = position.coords, time = position.timestamp;
      if (![latitude, longitude, accuracy, time].every(Number.isFinite) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || accuracy < 0 || accuracy > 100000 || time < started - 5000 || time > Date.now() + 10000) return;
      stop();
      callbacks.onComplete({ latitude, longitude, accuracy_meters: accuracy, captured_at: new Date(time).toISOString() });
    }, error => {
      if (!active) return;
      if (error.code === 1) fail('Allow location permission for this website in your browser and device settings, then try again.');
      else fail(error.code === 3 ? timeoutMessage : 'Your location could not be determined. Check location services and your connection, then try again.');
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 8000 });
    // Test doubles and some embedded browsers may invoke a callback before returning the watch ID.
    if (!active && watch !== undefined) { geo.clearWatch(watch); watch = undefined; }
  } catch { fail('Your browser could not start location access. Check permissions, or open this secure link in Safari or Chrome.'); }
  return { cancel: stop };
}
