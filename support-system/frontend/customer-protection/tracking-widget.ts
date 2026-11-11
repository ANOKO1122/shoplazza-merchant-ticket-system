/** 17TRACK's public widget uses this isolated tracking page for single-number results. */
export function trackingWidgetUrl(number: string, openedAt: number): string {
  const url = new URL('https://extcall.17track.net/en/track');
  url.searchParams.set('timestamp', String(openedAt));
  url.hash = new URLSearchParams({ apitype: '1', uheight: '560', nums: number.trim(), fc: '0', sc: '0' }).toString();
  return url.href;
}
