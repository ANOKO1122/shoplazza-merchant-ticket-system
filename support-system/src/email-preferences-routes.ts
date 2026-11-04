import express from 'express';
import rateLimit from 'express-rate-limit';
import { isProtectionHost } from './protection-host';
import { isSameOriginMutation } from './protection-domain';

export interface EmailPreferenceView {
  category: 'ticket' | 'protection';
  email_masked: string;
  unsubscribed: boolean;
}
export interface EmailPreferenceService {
  get(rawToken: unknown): Promise<EmailPreferenceView | null>;
  unsubscribe(rawToken: unknown): Promise<EmailPreferenceView | null>;
}
interface RouterOptions {
  getTicketPublicBaseUrl: () => Promise<string>;
  service?: EmailPreferenceService;
}
const defaultService: EmailPreferenceService = {
  get: async token => (await import('./email-preferences')).getEmailUnsubscribePreference(token),
  unsubscribe: async token => (await import('./email-preferences')).unsubscribeEmailByToken(token),
};
const validToken = (value: unknown): value is string => typeof value === 'string' && /^eu_[A-Za-z0-9_-]{43}$/.test(value);
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
const css = `
:root{color-scheme:light;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#203348;background:#f5f7fa;font-synthesis:none}*{box-sizing:border-box}body{margin:0;min-height:100vh}::selection{background:#cfe3f5;color:#173951}header{border-bottom:1px solid #dde5ec;background:#fff}header>div{max-width:960px;padding:24px;margin:auto;display:flex;align-items:center;gap:11px;font-weight:650;font-size:18px}header svg{color:#245f93;flex:none}main{max-width:600px;margin:72px auto;padding:0 24px}.panel{background:white;border:1px solid #d9e2eb;border-radius:14px;padding:36px}.state-icon{display:grid;place-items:center;width:52px;height:52px;border-radius:50%;background:#edf3f9;color:#3a688b;margin-bottom:24px}.success .state-icon{background:#eaf4ed;color:#326748}h1{font-size:28px;line-height:1.25;letter-spacing:-.025em;margin:0 0 18px;text-wrap:balance}p{font-size:15px;line-height:1.8;margin:0 0 17px;color:#4e6276;overflow-wrap:anywhere}strong{color:#203348;font-weight:600}.recipient{font-variant-numeric:tabular-nums}.details{border-top:1px solid #e0e7ee;margin-top:25px;padding-top:22px}.details p:last-child{margin-bottom:0}form{margin:29px 0 0}button{font-family:inherit;font-size:15px;font-weight:600;line-height:1.4;background:#1d619c;color:#fff;border:0;border-radius:7px;padding:13px 20px;min-height:46px;width:100%;cursor:pointer}button:hover{background:#164e7e}button:active{background:#123f66}button:focus-visible{outline:3px solid #75a9d7;outline-offset:4px}.hint{font-size:13px;line-height:1.7;margin:17px 0 0;color:#61758a}.page-note{text-align:center;font-size:12px;line-height:1.7;margin:23px 0;color:#64788b}.success h1{margin-bottom:20px}@media(max-width:600px){header>div{padding:20px;font-size:17px}main{margin:36px auto;padding:0 16px}.panel{padding:28px 23px}h1{font-size:26px}p{font-size:16px}.details{margin-top:24px;padding-top:20px}.state-icon{margin-bottom:22px}.hint{font-size:14px}button{font-size:16px;padding:14px 16px}.page-note{padding:0 16px}}@media(prefers-reduced-motion:no-preference){button{transition:background-color .15s ease-out}}
`;
function shell(title: string, body: string, success = false): string {
  const icon = success ? '<path d="m6 12 4 4 8-8"/>' : '<path d="M12 10v7M12 7h.01"/>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)} · Email preferences</title><style>${css}</style></head><body><header><div><svg aria-hidden="true" width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>Email preferences</div></header><main><section class="panel${success ? ' success' : ''}" aria-labelledby="page-title"><span class="state-icon"><svg aria-hidden="true" width="29" height="29" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/>${icon}</svg></span><h1 id="page-title">${escapeHtml(title)}</h1>${body}</section><p class="page-note">Email preferences only. No website sign-in is required.</p></main></body></html>`;
}
function preferencePage(preference: EmailPreferenceView, token: string): string {
  const protection = preference.category === 'protection';
  const scope = protection ? 'all shipping protection emails' : 'all ticket-related emails';
  const other = protection ? 'Ticket-related emails' : 'Shipping protection emails';
  const title = preference.unsubscribed ? 'You’re unsubscribed' : protection ? 'Unsubscribe from shipping protection emails?' : 'Unsubscribe from ticket emails?';
  const recipient = `<strong class="recipient">${escapeHtml(preference.email_masked)}</strong>`;
  return shell(title, `${preference.unsubscribed ? `<p>You will no longer receive <strong>${scope}</strong> at ${recipient}.</p>` : `<p>Confirm to stop <strong>${scope}</strong> sent to ${recipient}.</p>`}<div class="details"><p><strong>${other} are unaffected.</strong></p><p>This changes email delivery only. Website access, tickets, and shipping protection requests are unchanged.</p></div>${preference.unsubscribed ? '<p class="hint">Your preference has been saved. You can close this page.</p>' : `<form method="post" action="/email-preferences"><input type="hidden" name="token" value="${escapeHtml(token)}"><input type="hidden" name="confirm" value="unsubscribe"><button type="submit">Unsubscribe</button></form><p class="hint">To keep receiving these emails, close this page without confirming.</p>`}`, preference.unsubscribed);
}
function unavailable(res: express.Response, status = 404): void {
  res.status(status).type('html').send(shell('This email link is unavailable', '<p>Open the unsubscribe link in one of your emails and try again.</p><p>No email preferences were changed.</p>'));
}
async function categoryForHost(host: string, getTicketBase: RouterOptions['getTicketPublicBaseUrl']): Promise<EmailPreferenceView['category'] | null> {
  if (isProtectionHost(host)) return 'protection';
  const base = new URL(await getTicketBase());
  if (!['https:', 'http:'].includes(base.protocol) || !base.host) return null;
  return host.toLowerCase() === base.host.toLowerCase() ? 'ticket' : null;
}
const handler = (run: (req: express.Request, res: express.Response) => Promise<void>): express.RequestHandler => (req, res, next) => { void run(req, res).catch(next); };

/** Tokens grant only one category's email preference, never order or ticket access. */
export function createEmailPreferencesRouter(options: RouterOptions): express.Router {
  const router = express.Router({ caseSensitive: true, strict: true });
  const service = options.service || defaultService;
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });
  router.use(rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false, handler: (_req, res) => { res.status(429).type('html').send(shell('Please try again shortly', '<p>Too many requests were made. Wait a minute, then reopen your email link.</p>')); } }));
  router.get('/', handler(async (req, res) => {
    if (Object.keys(req.query).length !== 1 || !validToken(req.query.token)) { unavailable(res, 400); return; }
    const category = await categoryForHost(req.get('Host') || '', options.getTicketPublicBaseUrl);
    if (!category) { unavailable(res); return; }
    const preference = await service.get(req.query.token);
    if (!preference || preference.category !== category) { unavailable(res); return; }
    res.type('html').send(preferencePage(preference, req.query.token));
  }));
  router.post('/', (req, res, next) => {
    const origin = req.get('Origin'), site = req.get('Sec-Fetch-Site');
    // A no-referrer page's native form can serialize Origin as "null". Fetch
    // Metadata still confirms same-origin navigation; a cross-site form cannot.
    const sameOriginForm = origin === 'null' && site === 'same-origin';
    if (!sameOriginForm && !isSameOriginMutation(origin, site, req.protocol, req.get('Host'))) { unavailable(res, 403); return; }
    if (!req.is('application/x-www-form-urlencoded')) { unavailable(res, 415); return; }
    next();
  }, express.urlencoded({ extended: false, limit: '2kb', parameterLimit: 4 }), handler(async (req, res) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (Object.keys(req.query).length || !body || Object.keys(body).length !== 2 || body.confirm !== 'unsubscribe' || !validToken(body.token)) { unavailable(res, 400); return; }
    const category = await categoryForHost(req.get('Host') || '', options.getTicketPublicBaseUrl);
    if (!category) { unavailable(res); return; }
    const preference = await service.get(body.token);
    if (!preference || preference.category !== category) { unavailable(res); return; }
    const result = preference.unsubscribed ? preference : await service.unsubscribe(body.token);
    if (!result || result.category !== category || !result.unsubscribed) { unavailable(res); return; }
    res.type('html').send(preferencePage(result, ''));
  }));
  router.all('/', (_req, res) => { res.setHeader('Allow', 'GET, HEAD, POST'); unavailable(res, 405); });
  const errors: express.ErrorRequestHandler = (error, _req, res, _next) => {
    if (res.headersSent) return;
    if (error?.type === 'entity.too.large' || error?.type === 'parameters.too.many') { unavailable(res, 413); return; }
    // Never expose/log request URLs, tokens, masked recipients, or service errors.
    res.status(503).type('html').send(shell('Email preferences are temporarily unavailable', '<p>Reopen your email link and try again shortly.</p><p>We could not confirm a change to your email preferences.</p>'));
  };
  router.use(errors);
  return router;
}
