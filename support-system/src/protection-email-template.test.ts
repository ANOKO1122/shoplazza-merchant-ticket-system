import test from 'node:test';
import assert from 'node:assert/strict';
import { PROTECTION_COMPLETION_TEMPLATE, PROTECTION_EMAIL_PREVIEW_VARS } from './protection-email-template';
import { renderTemplateString } from './email-service';
import * as protectionTemplates from './protection-email-template';

test('protection mail defaults omit merchant names in subjects and bodies', () => {
  for (const template of [protectionTemplates.PROTECTION_SHIPMENT_TEMPLATE, protectionTemplates.PROTECTION_COMPLETION_TEMPLATE, protectionTemplates.PROTECTION_CLAIM_UPDATE_TEMPLATE]) {
    const rendered = renderTemplateString(template.subject + template.body, { ...PROTECTION_EMAIL_PREVIEW_VARS, store_name: 'Actual Merchant' });
    assert.doesNotMatch(rendered, /Actual Merchant|\{\{store_name\}\}/);
  }
});

// Simulate a mail sanitizer dropping fills while preserving link text colors.
// This is the reported failure mode, not an emulation of a specific QQ version.
function stripEmailBackgrounds(html: string): string {
  return html.replace(/\sbgcolor="[^"]*"/gi, '').replace(/style="([^"]*)"/gi, (_match, declarations: string) =>
    `style="${declarations.split(';').filter(declaration => !/^\s*background(?:-[\w-]+)?\s*:/i.test(declaration)).join(';')}"`);
}

function contrastAgainstWhite(color: string): number {
  const hex = color.replace('#', '');
  const expanded = hex.length === 3 ? hex.split('').map(value => value + value).join('') : hex;
  assert.match(expanded, /^[\da-f]{6}$/i);
  const rgb = expanded.match(/../g)!.map(value => {
    const channel = parseInt(value, 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 1.05 / (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] + 0.05);
}

for (const [type, template, label] of [
  ['shipment', (protectionTemplates as any).PROTECTION_SHIPMENT_TEMPLATE, 'View protected order'],
  ['completion', protectionTemplates.PROTECTION_COMPLETION_TEMPLATE, 'View order &amp; request support'],
  ['claim update', protectionTemplates.PROTECTION_CLAIM_UPDATE_TEMPLATE, 'View update'],
] as const) {
  test(`${type} CTA stays readable when mail sanitization strips every background`, () => {
    assert.ok(template, `${type} template must be registered`);
    const html = stripEmailBackgrounds(renderTemplateString(template.body, PROTECTION_EMAIL_PREVIEW_VARS));
    const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)];
    const cta = anchors.find(anchor => anchor[2].replace(/<[^>]+>/g, '') === label);
    assert.ok(cta, 'The primary action must remain visible text');
    assert.match(cta[1], /href="https:\/\/us-seel\.com\/protection"/);
    const style = cta[1].match(/style="([^"]*)"/)?.[1] || '';
    const textColor = style.match(/(?:^|;)\s*color\s*:\s*(#[\da-f]{3,6})\b/i)?.[1] || '#0000ee';
    assert.ok(contrastAgainstWhite(textColor) >= 4.5, 'CTA text must contrast with the mail client’s white canvas after its fill is removed');
  });

  test(`${type} includes a separate readable link to the same secure destination`, () => {
    assert.ok(template, `${type} template must be registered`);
    const html = renderTemplateString(template.body, PROTECTION_EMAIL_PREVIEW_VARS);
    const fallback = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)]
      .find(anchor => anchor[2] === 'Open your protection page');
    assert.ok(fallback, 'A separate text link must remain available if button rendering fails');
    assert.match(fallback[1], /href="https:\/\/us-seel\.com\/protection"/);
    const color = fallback[1].match(/(?:^|[";])\s*color\s*:\s*(#[\da-f]{3,6})\b/i)?.[1] || '#0000ee';
    assert.ok(contrastAgainstWhite(color) >= 4.5);
  });
}

test('shipment notification describes a partial shipment and uses the private protection page', () => {
  const template = (protectionTemplates as any).PROTECTION_SHIPMENT_TEMPLATE;
  assert.ok(template, 'Shipment template must be registered');
  const html = renderTemplateString(template.body, PROTECTION_EMAIL_PREVIEW_VARS);
  const subject = renderTemplateString(template.subject, PROTECTION_EMAIL_PREVIEW_VARS);
  assert.match(subject, /DEMO-1042/);
  assert.match(html, /A shipment from your protected order is on the way/);
  assert.match(html, /A shipment has been recorded/);
  assert.match(html, /Some items may ship separately/);
  assert.match(html, /Tracking number: DEMO-TRACKING-1042/);
  assert.match(html, /Carrier: Example carrier/);
  assert.match(html, /https:\/\/us-seel\.com\/protection/);
  assert.doesNotMatch(html, /Your order has (?:been delivered|shipped)|insurance|underwrit|resolve\.seel\.com|\{\{/i);

  const withoutTracking = renderTemplateString(template.body, {
    ...PROTECTION_EMAIL_PREVIEW_VARS, customer_name: '<script>bad</script>', carrier: '', tracking_number: '',
  });
  assert.match(withoutTracking, /&lt;script&gt;/);
  assert.doesNotMatch(withoutTracking, /<script|Tracking number:|Carrier:/);
});

test('protection template uses own secure portal without asserting carrier delivery', () => {
  const html = renderTemplateString(PROTECTION_COMPLETION_TEMPLATE.body, PROTECTION_EMAIL_PREVIEW_VARS);
  assert.match(html, /https:\/\/us-seel\.com\/protection/);
  assert.match(html, /View order &amp; request support/);
  assert.doesNotMatch(html, /Your order has been delivered|Powered by Seel|resolve\.seel\.com|\{\{/i);
  assert.doesNotMatch(html, /<script|tracking_pixel|Start a return/i);
});

test('template escapes customer text and hides absent shipment fields', () => {
  const html = renderTemplateString(PROTECTION_COMPLETION_TEMPLATE.body, {
    ...PROTECTION_EMAIL_PREVIEW_VARS, customer_name: '<img src=x onerror=alert(1)>', tracking_number: '', carrier: '',
  });
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img src=x|Tracking number:|Carrier:/);
});

test('claim update email links to the private request without exposing a decision or internal details', () => {
  const template = (protectionTemplates as any).PROTECTION_CLAIM_UPDATE_TEMPLATE;
  assert.ok(template, 'The claim update template must be registered');
  const html = renderTemplateString(template.body, { ...PROTECTION_EMAIL_PREVIEW_VARS, claim_no: 'CL-DEMO-1042' });
  assert.match(html, /Your request has been updated/);
  assert.match(html, /CL-DEMO-1042/);
  assert.match(html, /DEMO-1042/);
  assert.match(html, /View update/);
  assert.match(html, /https:\/\/us-seel\.com\/protection/);
  assert.doesNotMatch(html, /approved|rejected|bank|wire transfer|insurance|underwrit|\{\{/i);
});
