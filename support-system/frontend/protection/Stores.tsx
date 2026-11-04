import { useEffect, useRef, useState } from 'react';
import type { ProtectionInstallJob, ProtectionStore } from '../../src/protection-types';
import { dateTime, request, latestInstallJob } from './api';
import { Badge, Empty, ErrorNotice, Info, Section } from './shared';
const healthLabels: Record<ProtectionStore['health'], string> = { unknown: '待检测', healthy: '运行正常', disabled: '已停用', needs_adaptation: '主题待适配', error: '检测异常' };
const jobLabels: Record<ProtectionInstallJob['status'], string> = { queued: '排队中', running: '执行中', succeeded: '已完成', failed: '失败' };
const actionLabels: Record<ProtectionInstallJob['action'], string> = { check: '检测', install: '安装 / 启用', disable: '停用' };
export function Stores({ stores, isAdmin, onReload }: { stores: ProtectionStore[]; isAdmin: boolean; onReload: () => void }) {
  const [jobs, setJobs] = useState<Record<number, ProtectionInstallJob>>({});
  const [errors, setErrors] = useState<Record<number, Error | null>>({});
  const [busy, setBusy] = useState<Record<number, boolean>>({});
  const [confirm, setConfirm] = useState<{ id: number; action: 'install' | 'disable' } | null>(null);
  const guards = useRef(new Set<number>());
  const reloadRef = useRef(onReload);
  reloadRef.current = onReload;
  const pending = stores.map(store => ({ id: store.id, job: latestInstallJob(jobs[store.id], store.latest_job) })).filter((entry): entry is { id: number; job: ProtectionInstallJob } => !!entry.job && ['queued', 'running'].includes(entry.job.status));
  const pendingKey = pending.map(entry => `${entry.id}:${entry.job.id}`).join('|');
  useEffect(() => {
    if (!pending.length) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      let stillRunning = false;
      await Promise.all(pending.map(async ({ id, job }) => {
        try {
          const data = await request<{ job: ProtectionInstallJob }>(`/jobs/${encodeURIComponent(job.id)}`, { signal: controller.signal });
          if (controller.signal.aborted) return;
          setJobs(previous => ({ ...previous, [id]: data.job }));
          setErrors(previous => ({ ...previous, [id]: null }));
          if (['queued', 'running'].includes(data.job.status)) stillRunning = true;
          else reloadRef.current();
        } catch (error) {
          if (!controller.signal.aborted) { setErrors(previous => ({ ...previous, [id]: error as Error })); stillRunning = true; }
        }
      }));
      if (!controller.signal.aborted && stillRunning) timer = setTimeout(poll, 3000);
    }
    timer = setTimeout(poll, 1500);
    return () => { controller.abort(); clearTimeout(timer); };
    // A job identity change restarts polling; terminal status removes it from pendingKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey]);
  async function act(store: ProtectionStore, action: ProtectionInstallJob['action']) {
    if (guards.current.has(store.id)) return;
    guards.current.add(store.id); setBusy(previous => ({ ...previous, [store.id]: true })); setErrors(previous => ({ ...previous, [store.id]: null })); setConfirm(null);
    try {
      const data = await request<{ job: ProtectionInstallJob }>(`/stores/${store.id}/actions`, { method: 'POST', body: JSON.stringify({ action }) });
      setJobs(previous => ({ ...previous, [store.id]: data.job })); onReload();
    } catch (error) { setErrors(previous => ({ ...previous, [store.id]: error as Error })); }
    finally { guards.current.delete(store.id); setBusy(previous => ({ ...previous, [store.id]: false })); }
  }
  return <><div className="p-overview-heading"><div><h2>店铺接入</h2><p className="p-muted">组件启用状态与远端检测结果分别记录。切换主题后，请重新检测。</p></div><button className="p-button" onClick={onReload}>刷新列表</button></div>
    {!isAdmin && <p className="p-notice">只有管理员可以检测、安装、启用或停用店铺组件。</p>}
    {!stores.length ? <Empty title="暂无店铺">请先在店铺管理中接入店铺。</Empty> : <div className="p-store-list">{stores.map(store => {
      const job = latestInstallJob(jobs[store.id], store.latest_job);
      const running = busy[store.id] || !!job && ['queued', 'running'].includes(job.status);
      const unavailable = !isAdmin || running;
      const installDisabled = unavailable || !store.store_enabled || !store.configured || store.health === 'unknown' || store.health === 'needs_adaptation' || !store.theme_family;
      return <Section key={store.id} title={store.store_name || store.subdomain} action={<Badge status={store.health}>{healthLabels[store.health]}</Badge>}>
        <div className="p-store-domain">{store.subdomain}</div><dl className="p-info-grid p-store-info"><Info label="组件期望状态"><Badge status={store.enabled ? 'enabled' : 'disabled'}>{store.enabled ? '已启用' : '已停用'}</Badge></Info><Info label="后台店铺状态">{store.store_enabled ? '已启用' : '已停用'}</Info><Info label="组件配置">{store.configured ? '已配置' : '配置不完整'}</Info><Info label="当前主题">{store.active_theme_id || '尚未检测'}</Info><Info label="已适配主题">{store.theme_family ? `${store.theme_family}${store.theme_id ? ` · ${store.theme_id}` : ''}` : '待适配'}</Info><Info label="组件版本">{store.version || '尚未记录'}</Info><Info label="最近检测">{dateTime(store.checked_at)}</Info><Info label="保障商品">{store.product_ids.length ? store.product_ids.join('、') : '尚未配置'}</Info></dl>
        <p className={`p-health-message ${store.health === 'error' ? 'p-text-danger' : ''}`}>{store.health_message || '尚无远端检测结果，请先检测组件。'}</p>
        {store.health === 'needs_adaptation' && <p className="p-notice">当前主题尚未完成适配。请先完成适配验证，再安装或启用组件。</p>}
        <p className="p-muted p-space-after">订单完成后完成保障商品履约：{store.fulfillment_enabled ? '已启用' : '未启用'}。</p>
        {job && <div className={`p-job ${job.status === 'failed' ? 'p-job-failed' : ''}`} role={['queued', 'running'].includes(job.status) ? 'status' : undefined}><div><strong>{actionLabels[job.action]} · {jobLabels[job.status]}</strong><time>{dateTime(job.finished_at || job.created_at)}</time></div><p>{job.message || '任务已提交，等待执行结果。'}</p></div>}
        <ErrorNotice error={errors[store.id]} /><div className="p-actions"><button className="p-button" disabled={unavailable || !store.store_enabled} onClick={() => act(store, 'check')}>检测组件</button><button className="p-button p-primary" disabled={installDisabled} title={store.health === 'unknown' ? '请先检测组件' : !store.configured ? '请先完善店铺配置' : undefined} onClick={() => setConfirm({ id: store.id, action: 'install' })}>{store.enabled ? '重新安装组件' : '安装 / 启用组件'}</button><button className="p-button p-danger" disabled={unavailable || !store.enabled} onClick={() => setConfirm({ id: store.id, action: 'disable' })}>停用组件</button>{running && <span className="p-muted">正在处理，请等待任务完成。</span>}</div>
        {confirm?.id === store.id && <div className="p-confirm"><p>{confirm.action === 'disable' ? '停用后，该店铺将不再展示运输保障购买组件。已有保障与申诉记录继续保留。' : `确认在 ${store.store_name || store.subdomain} 安装并启用运输保障组件？将更新当前店铺的组件。`}</p><div className="p-actions"><button className="p-button p-primary" disabled={running} onClick={() => act(store, confirm.action)}>确认{confirm.action === 'disable' ? '停用' : '安装 / 启用'}</button><button className="p-button" onClick={() => setConfirm(null)}>取消</button></div></div>}
      </Section>;
    })}</div>}
  </>;
}
