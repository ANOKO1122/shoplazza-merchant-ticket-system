import test from 'node:test';
import assert from 'node:assert/strict';
import { protectionHelpArticles, renderProtectionHelp } from './protection-help';

test('public help articles use the customer portal rules and keep readers on this site', () => {
  assert.equal(protectionHelpArticles.length, 8);
  for (const slug of protectionHelpArticles) {
    const page = renderProtectionHelp(slug);
    assert.ok(page, slug);
    assert.match(page, /<aside class="help-sidebar">/);
    assert.match(page, /<main id="main-content">/);
    assert.equal((page.match(/aria-current="page"/g) || []).length, 2, slug);
    assert.equal((page.match(/<nav aria-label="Articles in this section">/g) || []).length, 2, slug);
    assert.doesNotMatch(page, /https?:\/\/|\b(insurance|insured|coverage|underwritten|Seel Cash)\b/i);
  }
  assert.match(renderProtectionHelp('lost-or-not-received')!, /60 days after shipment/);
  assert.match(renderProtectionHelp('lost-or-not-received')!, /does not prove that a carrier delivered/);
  assert.match(renderProtectionHelp('delivery-not-received-documents')!, /does not require a police report or carrier letter up front/);
  assert.match(renderProtectionHelp('police-report')!, /If the department will not take a report/);
  assert.match(renderProtectionHelp('damaged-photos')!, /I cannot use a camera/);
});

test('help only renders known articles and the old photo URL can use the same page', () => {
  assert.match(renderProtectionHelp(undefined)!, /How to report a package issue/);
  assert.match(renderProtectionHelp('damaged-photos')!, /Photos for a damaged item/);
  assert.equal(renderProtectionHelp('unknown'), null);
  assert.equal(renderProtectionHelp(['damaged-photos']), null);
  assert.equal(renderProtectionHelp('<script>'), null);
});
