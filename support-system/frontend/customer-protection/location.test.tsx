import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startLocationCapture } from './location';
const epoch = Date.parse('2026-11-08T12:00:00Z');
function fixture() {
  let success!: PositionCallback, failure!: PositionErrorCallback;
  const cleared: number[] = []; let options: PositionOptions | undefined;
  const geo = { watchPosition(ok: PositionCallback, fail: PositionErrorCallback, opts: PositionOptions) { success = ok; failure = fail; options = opts; return 7; }, clearWatch(id: number) { cleared.push(id); } };
  const completed: any[] = [], errors: string[] = [];
  const capture = startLocationCapture(geo, { onComplete: value => completed.push(value), onError: value => errors.push(value) });
  return { capture, completed, errors, cleared, options, emit(accuracy: number, longitude = -74, timestamp = Date.now()) { success({ coords: { latitude: 40.7, longitude, accuracy }, timestamp } as GeolocationPosition); }, fail(code: number) { failure({ code } as GeolocationPositionError); } };
}
test('the first fresh fix is accepted immediately and later readings are ignored', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: epoch }); const f = fixture();
  f.emit(250, -73.99);
  assert.equal(f.completed.length, 1); assert.equal(f.completed[0].accuracy_meters, 250);
  assert.equal(f.completed[0].longitude, -73.99); assert.deepEqual(f.cleared, [7]);
  assert.deepEqual(f.options, { enableHighAccuracy: true, maximumAge: 0, timeout: 8000 });
  f.emit(1, 0); t.mock.timers.tick(8000);
  assert.equal(f.completed.length, 1); assert.equal(f.completed[0].longitude, -73.99); assert.equal(f.errors.length, 0);
});
test('a silent location provider stops after eight seconds and cannot save a late fix', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: epoch }); const f = fixture();
  t.mock.timers.tick(7999); assert.equal(f.errors.length, 0);
  t.mock.timers.tick(1); assert.match(f.errors[0], /timed out/); assert.deepEqual(f.cleared, [7]);
  f.emit(10); assert.equal(f.completed.length, 0);
});
test('stale, future and malformed readings cannot become a saved location', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: epoch }); const f = fixture();
  f.emit(1, -74, epoch - 60000); f.emit(1, -74, epoch + 60000); f.emit(NaN); f.emit(1, 181);
  t.mock.timers.tick(8000); assert.equal(f.completed.length, 0); assert.equal(f.errors.length, 1);
});
test('cancel ignores late callbacks and a new request can capture another location', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: epoch }); const f = fixture();
  f.capture.cancel(); f.emit(1); t.mock.timers.tick(8000);
  assert.deepEqual([f.completed.length, f.errors.length], [0, 0]); assert.deepEqual(f.cleared, [7]);
  const second = fixture(); second.emit(40); assert.equal(second.completed[0].accuracy_meters, 40); assert.deepEqual(second.cleared, [7]);
});
test('permission refusal and synchronous failures clean up without retaining a watch', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: epoch }); const f = fixture();
  f.fail(1); assert.match(f.errors[0], /permission/); assert.deepEqual(f.cleared, [7]);
  const errors: string[] = [], cleared: number[] = [];
  startLocationCapture({ watchPosition(_ok, fail) { fail!({ code: 1 } as GeolocationPositionError); return 9; }, clearWatch(id) { cleared.push(id); } }, { onComplete() {}, onError: e => errors.push(e) });
  assert.equal(errors.length, 1); assert.deepEqual(cleared, [9]);
  startLocationCapture({ watchPosition() { throw new Error('blocked'); }, clearWatch() {} }, { onComplete() {}, onError: e => errors.push(e) });
  assert.equal(errors.length, 2); t.mock.timers.tick(8000); assert.equal(errors.length, 2);
});
