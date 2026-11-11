import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TrackingDialog } from './TrackingDialog';
import { trackingWidgetUrl } from './tracking-widget';

test('17TRACK widget receives the selected number in a fragment and browser language in its path', () => {
  const url = new URL(trackingWidgetUrl(' 4PX3003125442493CN ', 'zh-CN', 123));
  assert.equal(url.origin, 'https://extcall.17track.net');
  assert.equal(url.pathname, '/zh-cn/track');
  assert.equal(url.searchParams.get('timestamp'), '123');
  assert.equal(new URLSearchParams(url.hash.slice(1)).get('nums'), '4PX3003125442493CN');
  assert.equal(new URL(trackingWidgetUrl('ABC', '../bad', 123)).pathname, '/en/track');
});

test('tracking results stay in an isolated modal frame', () => {
  const html = renderToStaticMarkup(<TrackingDialog numbers={['ABC']} onClose={() => {}} />);
  assert.match(html, /<dialog[^>]*cp-tracking-dialog/);
  assert.match(html, /<iframe[^>]*sandbox="allow-scripts allow-forms allow-popups allow-same-origin"/);
  assert.match(html, /referrerPolicy="no-referrer"/);
  assert.doesNotMatch(html, /externalcall\.js/);
});
