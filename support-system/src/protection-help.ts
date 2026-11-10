/** Public order-help copy. Keep these instructions aligned with the customer flow. */
const articles = {
  'report-an-issue': {
    title: 'How to report a package issue',
    lead: 'Shipping Protection helps with shipping and delivery loss, damage, theft or major delays. With sufficient evidence and an approved request, you may receive a full or partial refund for affected items.',
    body: `<h2>Start from your order</h2>
      <ol><li>Open the order link in your email and choose <strong>Request a refund</strong>.</li><li>Say whether you received the package, then choose the closest issue.</li><li>Select the affected items and quantities. The form shows the request dates for each item.</li><li>Describe what happened, add any useful documents, and review your answers before submitting.</li></ol>
      <p>Use the secure order link from your email to get started. If you have not received the package, the form asks you to share your current location. It requests location only when you choose to share it.</p>
      <div class="help-note"><strong>After you submit</strong><p>The store reviews your request. Submitting it does not send a refund or decide the outcome.</p></div>
      <h2>Which issue should I choose?</h2><p>Choose damage when an item arrived damaged. Choose missing items when the package arrived without everything ordered. If the package has not arrived, choose the option that matches its current status. You can explain uncertain details in the description.</p>
      <p>Read <a href="/protection/help?article=lost-or-not-received">how to tell a missing shipment from a delivery you cannot find</a> or <a href="/protection/help?article=request-status">how to check your request status</a>.</p>`,
  },
  'request-status': {
    title: 'How to check your request status',
    lead: 'Your order page shows each request and the latest status recorded by the store.',
    body: `<h2>Status meanings</h2>
      <dl class="help-statuses"><div><dt>Request received</dt><dd>Your request has been submitted.</dd></div><div><dt>Under review</dt><dd>The store is reviewing the information.</dd></div><div><dt>More information needed</dt><dd>Open the request and send the details the store asked for.</dd></div><div><dt>Approved</dt><dd>The store approved the request. Any refund is handled separately; this status alone does not confirm payment.</dd></div><div><dt>Not approved</dt><dd>Read the store's message. You may submit a new request if the request window is still open and the items are eligible.</dd></div><div><dt>Handled externally</dt><dd>The store recorded that it handled the matter outside this portal.</dd></div></dl>
      <h2>Adding information</h2><p>While a request is received, under review, or needs more information, open it on your order page to add a message and any relevant files. For damage requests, new photos use the camera flow; you can also send a text-only update.</p>
      <p>Go to <a href="/protection/help?article=report-an-issue">How to report a package issue</a> for the submission steps.</p>`,
  },
  'lost-or-not-received': {
    title: 'Is my package lost or missing after delivery?',
    lead: 'The tracking record and your order page help you choose an issue. A store completion status does not prove that a carrier delivered the package.',
    body: `<h2>Still in transit or no delivery recorded</h2><p>If the package has not arrived and there is no confirmed delivery, select <strong>My package has not arrived</strong>. If it is significantly late, the delay option may be more appropriate. The form shows when each request window opens.</p>
      <p>For this service, delay requests open 30 days after the affected item ships. Loss requests open 60 days after shipment. Both close 90 days after the order date. The dates shown for your item in the order page are the ones to use.</p>
      <h2>Order marked complete, but no package</h2><p>If your order is marked complete and you have not received the package, choose <strong>My order is marked complete, but I have not received my package</strong>. First check nearby delivery spots, a mailroom or locker, household members, and neighbors. Ask the carrier to check the delivery details if possible.</p>
      <div class="help-note"><strong>What “missing after delivery” means here</strong><p>This option lets the store investigate a package you cannot find. It does not mean that theft has been established. A package can also be misplaced or delivered to the wrong place.</p></div>
      <p>See <a href="/protection/help?article=missing-package-documents">documents for a package that has not arrived</a> and <a href="/protection/help?article=delivery-not-received-documents">documents for a delivery you cannot find</a>.</p>`,
  },
  'missing-package-documents': {
    title: 'What information helps with a missing package?',
    lead: 'Start with what you know. The order page already shows the store your order and shipment details.',
    body: `<h2>In your request</h2><ul><li>Describe when you expected the package and the latest tracking update you can see.</li><li>Include the carrier name and tracking number if available.</li><li>Share your current location in the form. This is required when you say you have not received the package.</li></ul>
      <h2>Helpful documents</h2><p>If you have them, add a screenshot of the latest tracking update, a carrier inquiry or case number, or written confirmation from the carrier. These help the store review the timeline. The form does not require a carrier letter before you can submit.</p>
      <p>If the carrier cannot provide a letter, explain when you contacted them and what they said. The store may ask for more information through your request.</p>
      <p>Read <a href="/protection/help?article=carrier-confirmation">how to request written carrier confirmation</a>.</p>`,
  },
  'carrier-confirmation': {
    title: 'How to ask a carrier for written confirmation',
    lead: 'A carrier email, letter, or case record can help clarify where a package is, especially when tracking is unclear.',
    body: `<h2>Contact the carrier</h2><p>Use the carrier shown with your tracking number. Ask its support team to investigate the shipment and provide the result in writing, if available. The carrier may need the tracking number, recipient name, delivery address, and shipment date to locate the record.</p>
      <h2>What to ask them to include</h2><ul><li>The tracking number and their inquiry or case number.</li><li>The latest scan or delivery status, with the date and place if known.</li><li>Whether they can confirm delivery, loss, a return to sender, or an unresolved trace.</li><li>Where the package was left, if their records say it was delivered.</li></ul>
      <p>If the carrier only answers by phone, write down the date, case number, and the information they gave you. Add that summary to your request. If the carrier says the sender must open the inquiry, include that detail too.</p>
      <div class="help-note"><strong>Keep private details private</strong><p>Do not send payment card numbers or identity documents as supporting files.</p></div>`,
  },
  'damaged-photos': {
    title: 'Photos for a damaged item',
    lead: 'A clear photo of the affected item is required for a damage request. Photos of the package, label, and close-up details can help the store understand what happened.',
    body: `<h2>Start with the item</h2><p>Use the camera in the request form to take at least one clear photo of the damaged item. Show the whole item and the affected area. Add another angle if the damage is hard to see. You can take up to six photos in one request.</p>
      <h2>Show the package when you can</h2><div class="help-example"><div><p>Photograph the entire outer box or bag before taking close-ups of crushed, torn, or wet areas. Keep the shipping label on the package when possible.</p><p>A readable label can help match the package to your order. Keep payment cards and identity documents out of the frame.</p></div><figure><img src="/assets/protection-example-package.jpg" width="594" height="706" alt="Example showing a damaged shipping box and its label" loading="lazy"><figcaption>Example: full outer package</figcaption></figure></div>
      <h2>Show the product and damage</h2><div class="help-example"><div><p>Include the product with its packaging, then take a closer photo of the damaged area. Good light and a steady camera make details easier to review.</p><p>The package or label may help, but the damaged item photo is the one the form requires.</p></div><figure><img src="/assets/protection-example-item.jpg" width="293" height="353" alt="Example showing an affected item inside its packaging" loading="lazy"><figcaption>Example: item inside its packaging</figcaption></figure></div>
      <h2>If you cannot use a camera</h2><p>Choose <strong>I cannot use a camera</strong> in the form and explain why. The form replaces the photo controls with a text field, and the store reviews that explanation manually. No photo is required when using that option.</p>`,
  },
  'delivery-not-received-documents': {
    title: 'What helps when a delivery cannot be found?',
    lead: 'If your order is marked complete but you do not have the package, explain what you checked and share any records that may help locate it.',
    body: `<h2>Before submitting</h2><p>Look around the delivery address, mailroom, parcel locker, and any alternate delivery spot. Ask household members or building staff if they accepted the package. If the carrier marked it delivered, ask the carrier to check where it was left.</p>
      <h2>In the request</h2><ul><li>Describe when you noticed the package was missing and the places you checked.</li><li>Share your current location in the form. The form requires it for a package you have not received.</li><li>Add a tracking screenshot, carrier case number, delivery photo, or written response if you have one.</li><li>If available, a building note, security footage, or police incident number can provide more context.</li></ul>
      <div class="help-note"><strong>You can submit before getting every document</strong><p>The form does not require a police report or carrier letter up front. The store may ask for specific information after reviewing your request.</p></div>
      <p>If a police incident report is appropriate or the store asks for one, read <a href="/protection/help?article=police-report">how to file an incident report</a>.</p>`,
  },
  'police-report': {
    title: 'How to file a police incident report',
    lead: 'If you believe a package was taken, or the store asks for an incident report, your local police department can tell you how to report what you know.',
    body: `<h2>Find the right reporting channel</h2><p>Look up your local police department's non-emergency phone number or official website. Depending on where you live and the circumstances, it may accept a report online, by phone, or in person. Follow its instructions; the store cannot file the report for you.</p>
      <h2>Prepare the facts</h2><ul><li>Your name and the delivery address.</li><li>The order number, carrier, tracking number, and item description or value, if known.</li><li>The date and place the carrier says it delivered the package, if available.</li><li>What you checked and any carrier or building inquiry you made.</li></ul>
      <p>Describe only what you know. If you do not know whether the package was stolen or misplaced, say so. Ask for an incident or reference number and a copy or confirmation when one is available.</p>
      <h2>Share the result with the store</h2><p>Open your request on the order page and add the report number or a copy if the store has asked for it. If the department will not take a report or cannot provide a copy, explain that in your request instead.</p>`,
  },
} as const;

export type ProtectionHelpArticle = keyof typeof articles;
export const protectionHelpArticles = Object.keys(articles) as ProtectionHelpArticle[];

export function renderProtectionHelp(requested: unknown, fallback: ProtectionHelpArticle = 'report-an-issue'): string | null {
  const slug = requested === undefined ? fallback : requested;
  if (typeof slug !== 'string' || !Object.prototype.hasOwnProperty.call(articles, slug)) return null;
  const current = slug as ProtectionHelpArticle;
  const article = articles[current];
  const navigation = protectionHelpArticles.map(key => `<li><a href="/protection/help?article=${key}"${key === current ? ' aria-current="page"' : ''}>${articles[key].title}</a></li>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${article.title} · Order help</title><link rel="stylesheet" href="/assets/protection-help.css"></head>
<body><a class="help-skip" href="#main-content">Skip to article</a><header class="help-header"><div class="help-header-inner"><a class="help-brand" href="/protection/help">Order help</a><a class="help-order-link" href="/protection">Open your order</a></div></header>
<div class="help-breadcrumb"><div><a href="/protection/help">Help center</a><span aria-hidden="true">›</span><span>Reporting an issue</span></div></div>
<div class="help-layout"><aside class="help-sidebar"><div class="help-nav-desktop"><h2>Articles in this section</h2><nav aria-label="Articles in this section"><ul>${navigation}</ul></nav></div><details class="help-nav-mobile"><summary>Browse articles</summary><nav aria-label="Articles in this section"><ul>${navigation}</ul></nav></details></aside>
<main id="main-content"><article><h1>${article.title}</h1><p class="help-lead">${article.lead}</p><div class="help-article-body">${article.body}</div></article><footer class="help-footer"><span>Need to review your request?</span><a href="/protection">Open your order</a></footer></main></div></body></html>`;
}
