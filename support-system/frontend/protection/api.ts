import { useCallback, useEffect, useState } from 'react';
import type { ProtectionInstallJob } from '../../src/protection-types';
export function latestInstallJob(local: ProtectionInstallJob | undefined, remote: ProtectionInstallJob | null): ProtectionInstallJob | null {
  if (!local) return remote;
  if (!remote) return local;
  if (local.id !== remote.id) return BigInt(local.id) > BigInt(remote.id) ? local : remote;
  const rank = { queued: 0, running: 1, succeeded: 2, failed: 2 };
  return rank[local.status] > rank[remote.status] ? local : remote;
}
export const API = '/api/admin/protection';
export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path.startsWith('/api/') ? path : API + path, {
      ...init, credentials: 'same-origin', headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError('网络连接失败，请检查网络后重试。', 0);
  }
  if (response.status === 401) throw new ApiError('登录已过期，请重新登录后继续。当前填写内容会保留。', 401);
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || payload.ok === false) {
    throw new ApiError(payload?.error || payload?.message || `请求失败（${response.status}），请重试。`, response.status);
  }
  return payload as T;
}
export function useResource<T>(path: string | null, refresh = 0, keepPrevious = false) {
  const [state, setState] = useState<{ path: string | null; data: T | null; error: ApiError | null; loading: boolean }>({ path: null, data: null, error: null, loading: true });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState(previous => ({ path, data: keepPrevious && previous.path === path ? previous.data : null, error: null, loading: !!path }));
    if (path) request<T>(path, { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setState({ path, data, error: null, loading: false });
    }).catch(error => { if (!controller.signal.aborted) setState(previous => ({ path, data: keepPrevious && previous.path === path ? previous.data : null, error, loading: false })); });
    return () => controller.abort();
  }, [path, refresh, retry, keepPrevious]);
  const reload = useCallback(() => setRetry(value => value + 1), []);
  return { ...state, reload };
}
export function query(filters: Record<string, string | number | undefined>) {
  const values = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => { if (value !== undefined && value !== '') values.set(key, String(value)); });
  return values.toString();
}
export function money(cents: number | null | undefined, currency: string) {
  if (cents == null) return '待确认';
  return `${currency} ${(cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
export function dateTime(value: string | null | undefined) {
  if (!value) return '暂无记录';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}
export function centsFromInput(value: string): number | null {
  if (!/^\d+(\.\d{1,2})?$/.test(value.trim())) return null;
  const [whole, decimal = ''] = value.trim().split('.');
  const cents = Number(whole) * 100 + Number(decimal.padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}
export function safeUrl(value: unknown) {
  if (typeof value !== 'string' || !value) return undefined;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
}
