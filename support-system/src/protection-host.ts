import type { RequestHandler } from 'express';

const protectionPermissionsPolicy = 'geolocation=(self), camera=(self), microphone=()';

/** Never use the ticket system's public-base setting for the customer portal. */
export function isProtectionHost(host: string): boolean {
  return host.toLowerCase().replace(/:\d+$/, '') === 'us-seel.com';
}

export function isProtectionPublicPath(path: string): boolean {
  if (path === '/' || path === '/protection' || path === '/protection/photo-requirements' || path === '/protection/help' || path === '/email-preferences') return true;
  if (path === '/assets/customer-protection.js' || path === '/assets/customer-protection.css') return true;
  if (path === '/assets/protection-help.css') return true;
  if (path === '/assets/protection-location-ios.png' || path === '/assets/protection-location-android.png') return true;
  if (path === '/assets/protection-photo-guidelines.png' || path === '/assets/protection-camera-ios.png' || path === '/assets/protection-camera-android.png') return true;
  if (path === '/assets/protection-example-package.jpg' || path === '/assets/protection-example-item.jpg') return true;
  return /^\/api\/protection\/[A-Za-z0-9_/-]+$/.test(path) && !path.includes('//');
}

/** Defense in depth behind the dedicated nginx vhost. */
export const protectionHostBoundary: RequestHandler = (req, res, next) => {
  if (!isProtectionHost(req.get('host') || '')) return next();
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Permissions-Policy', protectionPermissionsPolicy);
  if (!isProtectionPublicPath(req.path)) {
    res.status(404).type('text/plain').send('Not found');
    return;
  }
  next();
};

export const protectionPageHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Permissions-Policy', protectionPermissionsPolicy);
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  next();
};
