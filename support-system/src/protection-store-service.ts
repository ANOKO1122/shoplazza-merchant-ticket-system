import fs from 'node:fs/promises';
import path from 'node:path';
import { getClient, query } from './pg';
import { getStoreBySubdomain } from './store-service';
import { buildStoreDomain } from './config';
import { protectionPackageDir, runProtectionInstaller, validateProtectionManifest, redactInstallerOutput } from './protection-installer';
import { ProtectionInstallJob, ProtectionStore } from './protection-types';

export class ProtectionStoreError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export async function seedProtectionStores(): Promise<void> {
  const directory = path.join(protectionPackageDir(), 'stores');
  let files: string[];
  try { files = await fs.readdir(directory); } catch (e: any) { if (e.code === 'ENOENT') return; throw e; }
  for (const file of files.filter(file => /^[a-z0-9-]+\.json$/.test(file))) {
    const config = JSON.parse(await fs.readFile(path.join(directory, file), 'utf8'));
    validateProtectionManifest(config, config.store);
    const stores = await query('SELECT subdomain FROM support_stores WHERE subdomain=$1 OR subdomain=$2', [config.store, config.store.replace('.myshoplaza.com','')]);
    for (const { subdomain } of stores.rows) {
      const inserted = await query(`INSERT INTO support_protection_stores(store_subdomain,enabled,product_ids,config_json)
        VALUES($1,$2,$3,$4) ON CONFLICT(store_subdomain) DO NOTHING`, [subdomain,config.enabled,JSON.stringify(config.products.map((p: any) => p.id)),JSON.stringify(config)]);
      if (inserted.rowCount) await query(`UPDATE support_protection_sync_state SET cursor_updated_at='1970-01-01',cursor_id=0 WHERE id=1`);
    }
  }
}

function jobRow(row: any): ProtectionInstallJob { return { id: String(row.id), store_subdomain: row.store_subdomain, action: row.action, status: row.status, message: row.message, created_at: new Date(row.created_at).toISOString(), finished_at: row.finished_at ? new Date(row.finished_at).toISOString() : null }; }

export async function listProtectionStores(): Promise<ProtectionStore[]> {
  const result = await query(`SELECT s.id,s.subdomain,s.store_name,s.enabled AS store_enabled,p.*,
    j.id AS job_id,j.action AS job_action,j.status AS job_status,j.message AS job_message,j.created_at AS job_created_at,j.finished_at AS job_finished_at
    FROM support_stores s LEFT JOIN support_protection_stores p ON p.store_subdomain=s.subdomain
    LEFT JOIN LATERAL(SELECT * FROM support_protection_install_jobs WHERE store_subdomain=s.subdomain ORDER BY id DESC LIMIT 1) j ON true ORDER BY s.id`);
  return result.rows.map(row => {
    const config = row.config_json;
    return { id: Number(row.id), subdomain: row.subdomain, store_name: row.store_name || row.subdomain, store_enabled: row.store_enabled,
      configured: !!config, enabled: row.enabled ?? false, theme_id: config?.themeId || null, theme_family: config?.themeFamily || null,
      active_theme_id: row.active_theme_id || null, version: config?.version || null, product_ids: row.product_ids || [],
      health: row.health || 'unknown', health_message: row.health_message || '尚未检测', checked_at: row.checked_at ? new Date(row.checked_at).toISOString() : null,
      fulfillment_enabled: row.fulfillment_enabled || false,
      latest_job: row.job_id ? jobRow({ id:row.job_id,store_subdomain:row.subdomain,action:row.job_action,status:row.job_status,message:row.job_message,created_at:row.job_created_at,finished_at:row.job_finished_at }) : null,
    };
  });
}

export async function enqueueProtectionInstall(storeId: number, action: string, actor: {agentId: number; name: string}): Promise<ProtectionInstallJob> {
  if (!Number.isSafeInteger(storeId) || storeId <= 0 || !['check','install','disable'].includes(action)) throw new ProtectionStoreError('无效的店铺操作');
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const found = await client.query('SELECT id,subdomain,enabled FROM support_stores WHERE id=$1 FOR UPDATE',[storeId]);
    const store = found.rows[0];
    if (!store) throw new ProtectionStoreError('店铺不存在',404);
    if (!store.enabled && action !== 'disable') throw new ProtectionStoreError('请先在店铺管理中启用此店铺');
    await client.query('INSERT INTO support_protection_stores(store_subdomain) VALUES($1) ON CONFLICT DO NOTHING',[store.subdomain]);
    const config = (await client.query('SELECT config_json,health FROM support_protection_stores WHERE store_subdomain=$1',[store.subdomain])).rows[0];
    if (action !== 'check' && (!config.config_json || config.health === 'needs_adaptation')) throw new ProtectionStoreError('需要先完成该主题的适配，再安装或暂停组件');
    const row = (await client.query(`INSERT INTO support_protection_install_jobs(store_subdomain,action,actor_id,actor_name) VALUES($1,$2,$3,$4) RETURNING *`,[store.subdomain,action,actor.agentId,actor.name])).rows[0];
    await client.query('COMMIT');
    return jobRow(row);
  } catch (error: any) {
    await client.query('ROLLBACK');
    if (error.code === '23505') throw new ProtectionStoreError('此店铺已有执行中的操作，请等待完成',409);
    throw error;
  } finally { client.release(); }
}

export async function getProtectionInstallJob(id: string): Promise<ProtectionInstallJob | null> {
  if (!/^[1-9]\d*$/.test(id)) return null;
  const row = (await query('SELECT * FROM support_protection_install_jobs WHERE id=$1',[id])).rows[0];
  return row ? jobRow(row) : null;
}

/** Single cross-process runner. A crash leaves an explicit failure, never retries a remote write blindly. */
export async function processProtectionInstallJobs(runInstaller: typeof runProtectionInstaller = runProtectionInstaller): Promise<void> {
  const client = await getClient();
  let locked = false;
  try {
    locked = (await client.query("SELECT pg_try_advisory_lock(hashtext('protection-install-worker')) AS locked")).rows[0].locked;
    if (!locked) return;
    await client.query(`UPDATE support_protection_install_jobs SET status='failed',message='执行中断，请检测店铺实际状态后重试',finished_at=now() WHERE status='running' AND started_at<now()-interval '20 minutes'`);
    const job = (await client.query(`UPDATE support_protection_install_jobs SET status='running',started_at=now(),message='正在执行'
      WHERE id=(SELECT id FROM support_protection_install_jobs WHERE status='queued' ORDER BY id LIMIT 1) RETURNING *`)).rows[0];
    if (!job) return;
    const store = await getStoreBySubdomain(job.store_subdomain);
    let token = '';
    try {
      if (!store || (!store.enabled && job.action !== 'disable')) throw new Error('店铺不存在或已停用');
      token = store.access_token;
      const saved = (await client.query('SELECT config_json FROM support_protection_stores WHERE store_subdomain=$1',[job.store_subdomain])).rows[0];
      const executed = await runInstaller(buildStoreDomain(store.subdomain),job.action,saved?.config_json,token);
      if (executed.manifest) await client.query(`UPDATE support_protection_stores SET config_json=$2,enabled=$3,product_ids=$4,updated_at=now() WHERE store_subdomain=$1`,[job.store_subdomain,JSON.stringify(executed.manifest),executed.manifest.enabled,JSON.stringify(executed.manifest.products.map((p: any) => p.id))]);
      if (executed.error) throw executed.error;
      const result = executed.result!;
      await client.query(`UPDATE support_protection_stores SET health=$2,health_message=$3,active_theme_id=$4,checked_at=now(),updated_at=now(),
        first_install_day=coalesce(first_install_day,CASE WHEN $5='install' THEN (now() AT TIME ZONE 'UTC')::date END)
        WHERE store_subdomain=$1`,[job.store_subdomain,result.health,result.message,result.active_theme_id || null,job.action]);
      await client.query(`UPDATE support_protection_install_jobs SET status='succeeded',message=$2,finished_at=now() WHERE id=$1`,[job.id,result.message]);
    } catch (error: any) {
      const message = redactInstallerOutput(error.message || '执行失败，请重新检测后重试',token);
      await client.query(`UPDATE support_protection_stores SET health='error',health_message=$2,checked_at=now(),updated_at=now() WHERE store_subdomain=$1`,[job.store_subdomain,message]);
      await client.query(`UPDATE support_protection_install_jobs SET status='failed',message=$2,finished_at=now() WHERE id=$1`,[job.id,message]);
    }
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtext('protection-install-worker'))");
    client.release();
  }
}
