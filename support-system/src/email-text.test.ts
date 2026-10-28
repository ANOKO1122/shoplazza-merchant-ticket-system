import test from 'node:test';
import assert from 'node:assert/strict';
import { emailHtmlToText } from './email-text';

test('emailHtmlToText preserves paragraphs, line breaks, heading case and decoded characters', () => {
  const text = emailHtmlToText(`
    <h2 style="color:#111111">Your support update</h2>
    <p>Hello, Taylor &amp; Co. &#x2014; you&#39;re welcome.</p>
    <p>Order&nbsp;#1001 costs &euro;25.<br>We&#8217;ll help with &lt;questions&gt;.</p>
  `);

  assert.match(text, /^Your support update\n\nHello, Taylor & Co\. — you're welcome\./);
  assert.match(text, /welcome\.\n\nOrder[\s\u00a0]#1001 costs €25\.\nWe’ll help with <questions>\.$/);
  assert.doesNotMatch(text, /<h2>|&amp;|&#|&nbsp;/);
});

test('emailHtmlToText includes complete CTA URLs with decoded query parameters and no wrapping', () => {
  const token = 'fixture_'.repeat(30);
  const url = `https://support.example.invalid/ticket?t=${token}&source=email#reply`;
  const text = emailHtmlToText(`<p><a style="display:inline-block" href="${url.replace('&', '&amp;')}">View your reply</a></p>`);

  assert.ok(text.includes('View your reply'));
  assert.ok(text.includes(url), 'the entire original token URL must remain contiguous');
  assert.equal(text.split('\n').length, 1);
});

test('emailHtmlToText does not repeat a URL already shown as the link text', () => {
  const url = 'https://support.example.invalid/ticket?t=fixture_token';
  assert.equal(emailHtmlToText(`<p><a href="${url}">${url}</a></p>`), url);
});

test('emailHtmlToText keeps nested layout and order detail tables in readable document order', () => {
  const text = emailHtmlToText(`
    <table role="presentation"><tr><td>
      <h2>Your order</h2><p>Hello Taylor,</p>
      <table role="presentation">
        <tr><td>Order number</td><td>#1001</td></tr>
        <tr><td>Items</td><td><table role="presentation">
          <tr><td>1.</td><td>Blue mug ×2</td></tr>
          <tr><td>2.</td><td>Tea &amp; biscuits ×1</td></tr>
        </table></td></tr>
        <tr><th>Total paid</th><td>USD 25.00</td></tr>
      </table>
      <p>Contact us anytime.</p>
    </td></tr></table>
  `);

  assert.match(text, /Your order\n\nHello Taylor,/);
  assert.match(text, /Order number[ \t]+#1001/);
  assert.match(text, /1\.[ \t]+Blue mug ×2\n2\.[ \t]+Tea & biscuits ×1/);
  assert.match(text, /Total paid[ \t]+USD 25\.00/);
  assert.ok(text.indexOf('Order number') < text.indexOf('Blue mug'));
  assert.ok(text.indexOf('Tea & biscuits') < text.indexOf('Total paid'));
  assert.ok(text.endsWith('Contact us anytime.'));
  assert.doesNotMatch(text, / {4,}|\n{3,}/, 'layout tables must not become a padded text grid');
});

test('emailHtmlToText collapses empty layout rows to a single blank line between content', () => {
  const text = emailHtmlToText(`
    <table role="presentation">
      <tr><td><p>Our support team has replied.</p></td></tr>
      <tr><td> </td></tr><tr><td> </td></tr>
      <tr><td><table role="presentation"><tr><td> </td></tr></table></td></tr>
      <tr><td><p>Related Order: #1001</p></td></tr>
      <tr><td> </td></tr><tr><td> </td></tr>
      <tr><td><p>Please view your reply.</p></td></tr>
    </table>
  `);

  assert.equal(text, 'Our support team has replied.\n\nRelated Order: #1001\n\nPlease view your reply.');
});

test('emailHtmlToText excludes head content, scripts and hidden preheaders without dropping visible copy', () => {
  const text = emailHtmlToText(`<!doctype html><html>
    <head><title>Inbox title</title><style>.intro { color: red; }</style></head>
    <body>
      <div style="padding:0; DISPLAY : none !important;">Hidden preview A</div>
      <div style="display:none">Hidden preview B</div>
      <span hidden>Hidden preview C</span>
      <div style="visibility: hidden">Hidden preview D</div>
      <div style="mso-hide:all;">Hidden preview E</div>
      <div style="display:block; color:red">Visible introduction.</div>
      <p>Thank you for your order.</p>
      <script>hiddenScript()</script>
    </body>
  </html>`);

  assert.match(text, /Visible introduction\./);
  assert.match(text, /Thank you for your order\./);
  assert.doesNotMatch(text, /Hidden preview|Inbox title|hiddenScript|color: red/);
});
