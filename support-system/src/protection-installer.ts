import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const protectionPackageDir = () => process.env.SUPPORT_PROTECTION_PACKAGE_DIR || path.resolve(__dirname, '../../shipping-protection');
const safeId = /^[a-z0-9-]+$/;
export function validateProtectionManifest(value: any, domain: string): void {
  const products = Array.isArray(value?.products) ? value.products : [];
  const retiredProducts = Array.isArray(value?.retiredProducts) ? value.retiredProducts : [];
  const activeIds = new Set(products.map((p: any) => p.id));
  const managedIds = new Set([...products, ...retiredProducts].map((p: any) => p.id));
  if (!value || value.store !== domain || !/^[a-z0-9-]+\.myshoplaza\.com$/.test(domain)
    || !safeId.test(value.themeId) || !/^\d+$/.test(value.shopId) || !['hero','nova'].includes(value.themeFamily)
    || !/^[a-z0-9-]+\.js$/.test(value.asset) || !products.length
    || (value.retiredProducts !== undefined && !Array.isArray(value.retiredProducts))
    || [...products, ...retiredProducts].some((p: any) => !safeId.test(p.id) || !safeId.test(p.handle))
    || managedIds.size !== products.length + retiredProducts.length
    || !Array.isArray(value.tiers) || !value.tiers.length || value.tiers.some((t: any) => !safeId.test(t.variantId) || !managedIds.has(t.productId) || (t.active !== false && !activeIds.has(t.productId)) || (t.active !== undefined && typeof t.active !== 'boolean') || !Number.isSafeInteger(t.cents) || t.cents < 198)
    || !Array.isArray(value.hostnames) || !value.hostnames.includes(domain)) throw new Error('安装配置不完整或与店铺不符，需要先完成主题适配');
}
export function redactInstallerOutput(output: string, token: string): string {
  return (token ? output.split(token).join('[redacted]') : output).replace(/(Authorization|access_token)[=: ]+(?:Bearer\s+)?[^\s,}]+/gi, '$1=[redacted]').slice(-2000);
}
export function parseInstallerResult(output: string): { health: string; message: string; active_theme_id?: string } {
  for (const line of output.trim().split('\n').reverse()) {
    try { const value = JSON.parse(line); if (value.protection_result === true && ['healthy','disabled','needs_adaptation','error'].includes(value.health) && typeof value.message === 'string') return value; } catch { /* CLI progress is not a result. */ }
  }
  throw new Error('执行结束但未返回完整检测结果，请重新检测');
}

/** Separate writable working directory per store. Credentials only enter a child environment. */
export async function runProtectionInstaller(domain: string, action: 'check'|'install'|'disable', manifest: any, token: string) {
  if (!/^[a-z0-9-]+\.myshoplaza\.com$/.test(domain)) throw new Error('店铺域名不符合店匠格式');
  if (manifest) validateProtectionManifest(manifest, domain);
  if (action !== 'check' && !manifest) throw new Error('该店铺尚未完成主题适配，暂不能发布组件');
  const source = protectionPackageDir();
  const name = domain.replace('.myshoplaza.com', '');
  const data = process.env.SUPPORT_PROTECTION_DATA_DIR || path.resolve(__dirname, '../protection-data');
  const runtime = path.join(data, name);
  await fs.mkdir(path.join(runtime, 'stores'), { recursive: true });
  for (const item of ['scripts','extensions','storefront','branding.mjs','catalog.mjs','package.json']) {
    await fs.cp(path.join(source, item), path.join(runtime, item), { recursive: true, force: true });
  }
  try { await fs.symlink(path.join(source, 'node_modules'), path.join(runtime, 'node_modules'), 'dir'); } catch (e: any) { if (e.code !== 'EEXIST') throw e; }
  const configPath = path.join(runtime, 'stores', name + '.json');
  if (manifest) await fs.writeFile(configPath, JSON.stringify(manifest));
  let output = '';
  let error: Error | null = null;
  try {
    output = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(runtime, 'scripts/admin-command.mjs'), name, action], {
        cwd: runtime, detached: true, stdio: ['ignore','pipe','pipe'],
        // Every nested CLI request also honors this deadline if this server process exits.
        env: { ...process.env, SHOPLAZZA_ACCESS_TOKEN: token, PROTECTION_DEADLINE_AT: String(Date.now() + 14 * 60_000) },
      });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} reject(new Error('安装执行超时，请先检测当前状态后重试')); }, 15 * 60_000);
      child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-500_000); });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-10_000); });
      child.once('error', () => { clearTimeout(timer); reject(new Error('无法启动安装程序，请检查部署包')); });
      child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(redactInstallerOutput(stderr || stdout || '安装程序执行失败', token))); });
    });
  } catch (e: any) { error = e; }
  // A failed remote operation may already have created a version; keep its IDs for recovery.
  const nextManifest = manifest ? JSON.parse(await fs.readFile(configPath, 'utf8')) : null;
  if (nextManifest) validateProtectionManifest(nextManifest, domain);
  return { result: error ? null : parseInstallerResult(output), manifest: nextManifest, error };
}
