/** 17TRACK's public widget uses this isolated tracking page for single-number results. */
export function trackingWidgetUrl(number: string, language: string, openedAt: number): string {
  const locale = /^[a-z]{2,3}(?:-[a-z]{2,4})?$/i.test(language) ? language.toLowerCase() : 'en';
  const url = new URL(`https://extcall.17track.net/${encodeURIComponent(locale)}/track`);
  url.searchParams.set('timestamp', String(openedAt));
  url.hash = new URLSearchParams({ apitype: '1', uheight: '560', nums: number.trim(), fc: '0', sc: '0' }).toString();
  return url.href;
}
