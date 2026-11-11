/** Editable templates used by the protection notification worker. */
export const PROTECTION_SHIPMENT_EMAIL_TYPE = 'protection_shipment_notice';
export const PROTECTION_COMPLETION_EMAIL_TYPE = 'protection_completion_notice';
export const PROTECTION_CLAIM_UPDATE_EMAIL_TYPE = 'protection_claim_update';

// Dark text remains readable when a mail client removes background fills.
function protectionEmailAction(label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="#e8f0f8" style="border-radius:6px;background-color:#e8f0f8"><a href="{{protection_link}}" style="display:inline-block;padding:14px 24px;border:1px solid #255c98;border-radius:6px;background-color:#e8f0f8;color:#17466f;text-decoration:underline;font-size:16px;line-height:1.5;font-weight:700">${label}</a></td></tr></table>`;
}

export const PROTECTION_SHIPMENT_TEMPLATE = {
  subject: '{{#store_domain}}{{store_domain}} — {{/store_domain}}Shipping Protection: a shipment from order #{{order_number}}',
  body: `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>A shipment from your protected order</title></head>
<body style="margin:0;padding:0;background:#f5f7fa;-webkit-text-size-adjust:100%;color:#172b43">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #e2e8ef;border-radius:12px;font-family:Arial,Helvetica,sans-serif;line-height:1.6">
<tr><td align="center" style="padding:28px 28px 12px;color:#526780;font-size:13px;font-weight:700;letter-spacing:1px">SHIPPING PROTECTION{{#store_domain}} · {{store_domain}}{{/store_domain}}</td></tr>
<tr><td align="center" style="padding:4px 28px 20px"><h1 style="font-size:28px;line-height:1.3;margin:0;color:#172b43">A shipment from your protected order is on the way</h1></td></tr>
<tr><td align="center" style="padding:0 28px 12px;font-size:20px;font-weight:700">Hi {{customer_name}},</td></tr>
<tr><td align="center" style="padding:0 28px 24px;font-size:15px;color:#526174">A shipment has been recorded for your protected order. Some items may ship separately. You can view your order, check the request windows, and report an eligible delivery issue on your private protection page.</td></tr>
<tr><td align="center" style="padding:0 24px 28px">${protectionEmailAction('View protected order')}</td></tr>
<tr><td style="padding:0 28px 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f6f8fb;border-radius:8px;font-size:14px"><tr><td style="padding:18px 20px">
<p style="margin:0 0 6px">Order: <strong>#{{order_number}}</strong></p>
<p style="margin:0 0 6px">Protection reference: <strong>{{protection_no}}</strong></p>
{{#tracking_number}}<p style="margin:0 0 6px;word-break:break-all">Tracking number: {{tracking_number}}</p>{{/tracking_number}}
{{#carrier}}<p style="margin:0">Carrier: {{carrier}}</p>{{/carrier}}
</td></tr></table></td></tr>
<tr><td style="padding:0 28px 24px;font-size:13px;color:#607085">Requests are reviewed by the support team. Submitting a request does not issue a refund automatically.</td></tr>
<tr><td align="center" style="border-top:1px solid #e2e8ef;padding:22px 28px;font-size:12px;color:#607085">This private link gives access to your order. Please do not share it.<br><a href="{{protection_link}}" style="color:#255c98;text-decoration:underline">Open your protection page</a></td></tr>
</table></td></tr></table></body></html>`,
};

export const PROTECTION_CLAIM_UPDATE_TEMPLATE = {
  subject: '{{#store_domain}}{{store_domain}} — {{/store_domain}}Your request has been updated — {{claim_no}}',
  body: `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Your request has been updated</title></head>
<body style="margin:0;padding:0;background:#f5f7fa;color:#172b43;-webkit-text-size-adjust:100%">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#fff;border:1px solid #e2e8ef;border-radius:12px;font-family:Arial,Helvetica,sans-serif;line-height:1.6">
<tr><td style="padding:28px 28px 12px;font-size:13px;color:#526780;font-weight:700">SHIPPING PROTECTION{{#store_domain}} · {{store_domain}}{{/store_domain}}</td></tr>
<tr><td style="padding:0 28px 20px"><h1 style="margin:0;font-size:28px;line-height:1.3">Your request has been updated</h1></td></tr>
<tr><td style="padding:0 28px 20px;font-size:15px">Hi {{customer_name}},<br><br>There is an update to your request. Open your secure page to view the latest information and any next steps.</td></tr>
<tr><td style="padding:0 28px 24px;font-size:14px"><p style="margin:0 0 6px">Request: <strong>{{claim_no}}</strong></p><p style="margin:0">Order: <strong>#{{order_number}}</strong></p></td></tr>
<tr><td style="padding:0 28px 28px">${protectionEmailAction('View update')}</td></tr>
<tr><td style="border-top:1px solid #e2e8ef;padding:22px 28px;font-size:12px;color:#607085">This private link gives access to your order. Please do not share it.<br>For help, open your request using the link above.<br><a href="{{protection_link}}" style="color:#255c98;text-decoration:underline">Open your protection page</a></td></tr>
</table></td></tr></table></body></html>`,
};
export const PROTECTION_COMPLETION_TEMPLATE = {
  subject: '{{#store_domain}}{{store_domain}} — {{/store_domain}}Shipping Protection: an update on order #{{order_number}}',
  body: `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Your protected order</title></head>
<body style="margin:0;padding:0;background:#f5f7fa;-webkit-text-size-adjust:100%;color:#172b43">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">View your protected order and request help with a delivery issue.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #e2e8ef;border-radius:12px;font-family:Arial,Helvetica,sans-serif;line-height:1.6">
<tr><td align="center" style="padding:28px 28px 12px;color:#526780;font-size:13px;font-weight:700;letter-spacing:1px">SHIPPING PROTECTION{{#store_domain}} · {{store_domain}}{{/store_domain}}</td></tr>
<tr><td align="center" style="padding:4px 28px 20px"><h1 style="font-size:30px;line-height:1.25;margin:0;color:#172b43">An update on your<br>protected order</h1></td></tr>
<tr><td align="center" style="padding:0 28px 12px;font-size:20px;font-weight:700">Hi {{customer_name}},</td></tr>
<tr><td align="center" style="padding:0 28px 24px;font-size:15px;color:#526174">Your order has been marked complete. If something is missing, damaged, or has not arrived, you can review your order and request support below.</td></tr>
<tr><td align="center" style="padding:0 24px 28px">${protectionEmailAction('View order &amp; request support')}</td></tr>
<tr><td style="padding:0 28px 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f6f8fb;border-radius:8px;font-size:14px"><tr><td style="padding:18px 20px">
<p style="margin:0 0 6px">Order: <strong>#{{order_number}}</strong></p>
<p style="margin:0 0 6px">Protection reference: <strong>{{protection_no}}</strong></p>
{{#tracking_number}}<p style="margin:0 0 6px;word-break:break-all">Tracking number: {{tracking_number}}</p>{{/tracking_number}}
{{#carrier}}<p style="margin:0">Carrier: {{carrier}}</p>{{/carrier}}
</td></tr></table></td></tr>
<tr><td style="padding:0 28px 24px;font-size:13px;color:#607085">Requests are reviewed by the support team. Submitting a request does not issue a refund automatically.</td></tr>
<tr><td align="center" style="border-top:1px solid #e2e8ef;padding:22px 28px;font-size:12px;color:#607085">This private link gives access to your order. Please do not share it.<br><a href="{{protection_link}}" style="color:#255c98;text-decoration:underline">Open your protection page</a></td></tr>
</table></td></tr></table></body></html>`,
};

/** Synthetic values only; the sample link never grants access to a real order. */
export const PROTECTION_EMAIL_PREVIEW_VARS: Record<string, string> = {
  store_name: 'example.invalid', store_domain: 'example.invalid', order_id: 'example-order',
  order_number: 'DEMO-1042', customer_name: 'Alex', customer_email: 'alex@example.invalid',
  protection_no: 'SP-DEMO-1042', claim_no: 'CL-DEMO-1042', protection_link: 'https://us-seel.com/protection',
  client_link: 'https://us-seel.com/protection', tracking_number: 'DEMO-TRACKING-1042', carrier: 'Example carrier',
};
