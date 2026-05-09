#!/usr/bin/env node
/**
 * 将 .env.mabang-bridge 中的店匠店铺配置迁移到桥接 SQLite（通过 /admin/stores）。
 * 需要：Node 18+（内置 fetch）、BRIDGE_ADMIN_TOKEN 已写在 env 文件中、桥接已启动。
 *
 * 用法：
 *   node scripts/migrate-shoplazza-stores-to-db.js
 *   node scripts/migrate-shoplazza-stores-to-db.js /path/to/.env.mabang-bridge
 *   BRIDGE_URL=http://127.0.0.1:4000 node scripts/migrate-shoplazza-stores-to-db.js
 */

const fs = require('fs');
const path = require('path');

var major = parseInt(process.versions.node.split('.')[0], 10);
if (major < 18 || Number.isNaN(major)) {
  console.error('需要 Node 18+。可改用:');
  console.error(
    'docker run --rm -v "$PWD:/w" -w /w --network host node:18-alpine node scripts/migrate-shoplazza-stores-to-db.js'
  );
  process.exit(1);
}

/** 与桥接 normalizeShoplazzaSubdomain 一致 */
function normalizeSubdomain(raw) {
  var s = (raw || '').trim();
  if (!s) return '';
  s = s.replace(/^https?:\/\//i, '');
  var parts = s.split('/');
  var first = parts[0] != null ? String(parts[0]).trim() : '';
  var host = first || s;
  var lower = host.toLowerCase();
  var suffix = '.myshoplaza.com';
  if (lower.endsWith(suffix)) {
    return host.slice(0, host.length - suffix.length).trim();
  }
  return host.trim();
}

/** 简单 .env 解析：不覆盖已在 shell 中 export 的变量 */
function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error('找不到配置文件:', filePath);
    process.exit(1);
  }
  var text = fs.readFileSync(filePath, 'utf8');
  var lines = text.split('\n');
  for (var li = 0; li < lines.length; li++) {
    var line = lines[li];
    var t = line.replace(/\r$/, '').trim();
    if (!t || t.charAt(0) === '#') continue;
    var eq = t.indexOf('=');
    if (eq < 1) continue;
    var key = t.slice(0, eq).trim();
    var val = t.slice(eq + 1).trim();
    if (
      (val.charAt(0) === '"' && val.slice(-1) === '"') ||
      (val.charAt(0) === "'" && val.slice(-1) === "'")
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

async function main() {
  var envPath = path.resolve(process.argv[2] || path.join(__dirname, '..', '.env.mabang-bridge'));
  loadEnvFile(envPath);

  var token = (process.env.BRIDGE_ADMIN_TOKEN || '').trim();
  var base = (process.env.BRIDGE_URL || 'http://127.0.0.1:4000').replace(/\/$/, '');

  if (!token) {
    console.error('未设置 BRIDGE_ADMIN_TOKEN，请先在 .env.mabang-bridge 中配置（或 export）。');
    process.exit(1);
  }

  /** @type {Array<{ subdomain: string; accessToken: string; label?: string }>} */
  var stores = [];
  var jsonRaw = (process.env.SHOPLAZZA_STORES_JSON || '').trim();

  if (jsonRaw) {
    var parsed;
    try {
      parsed = JSON.parse(jsonRaw);
    } catch (e) {
      var em = e instanceof Error ? e.message : String(e);
      console.error('SHOPLAZZA_STORES_JSON 不是合法 JSON:', em);
      process.exit(1);
    }
    if (!Array.isArray(parsed)) {
      console.error('SHOPLAZZA_STORES_JSON 须为 JSON 数组');
      process.exit(1);
    }
    for (var i = 0; i < parsed.length; i++) {
      var item = parsed[i];
      var subdomain = normalizeSubdomain(String(item.subdomain != null ? item.subdomain : ''));
      var accessToken = String(
        item.accessToken != null ? item.accessToken : item.access_token != null ? item.access_token : ''
      ).trim();
      var label = item.label != null ? String(item.label).trim() : undefined;
      if (!subdomain || !accessToken) {
        console.warn('跳过无效项（缺 subdomain 或 accessToken）');
        continue;
      }
      var row = { subdomain: subdomain, accessToken: accessToken };
      if (label) row.label = label;
      stores.push(row);
    }
  } else {
    var subOne = normalizeSubdomain(process.env.SHOPLAZZA_SUBDOMAIN || '');
    var tokOne = (process.env.SHOPLAZZA_ACCESS_TOKEN || '').trim();
    if (subOne && tokOne) {
      stores.push({ subdomain: subOne, accessToken: tokOne, label: subOne });
    }
  }

  if (stores.length === 0) {
    console.error(
      '未找到店铺：请在',
      envPath,
      '中配置 SHOPLAZZA_STORES_JSON 或 SHOPLAZZA_SUBDOMAIN + SHOPLAZZA_ACCESS_TOKEN'
    );
    process.exit(1);
  }

  for (var j = 0; j < stores.length; j++) {
    var s = stores[j];
    var r = await fetch(base + '/admin/stores', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
      },
      body: JSON.stringify(s),
    });
    var bodyText = await r.text();
    if (!r.ok) {
      console.error('POST 失败', s.subdomain, r.status, bodyText.slice(0, 500));
      process.exit(1);
    }
    console.log('已写入', s.subdomain);
  }

  console.log(
    '完成：共',
    stores.length,
    '个店铺。SQLite 已有数据后，桥接将优先使用数据库；可再视情况注释/删除 env 中的店匠 token（勿提交仓库）。'
  );
}

main().catch(function (e) {
  console.error(e);
  process.exit(1);
});
