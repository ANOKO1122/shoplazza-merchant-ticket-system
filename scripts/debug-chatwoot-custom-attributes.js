#!/usr/bin/env node
/**
 * 调试脚本：请求 Chatwoot 列出自定义属性定义（联系人），并将结果写入 debug 日志。
 * 用于判断「设置 → 自定义属性」为空是「从未创建定义」还是「API/前端未返回」。
 * 使用方式：在 chatwoot-docker 目录下执行
 *   node -e "$(cat scripts/debug-chatwoot-custom-attributes.js)"
 * 或
 *   node scripts/debug-chatwoot-custom-attributes.js
 * 需先设置环境变量或确保 .env.mabang-bridge 存在且已加载（见下方 loadEnv）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

const LOG_PATH = '/root/chatwoot-docker/.cursor/debug-f0da23.log';
const SESSION_ID = 'f0da23';

function httpGet(url, headers, opts = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        const out = { status: res.statusCode, body };
        if (opts.captureHeaders) out.headers = res.headers;
        resolve(out);
      });
    });
    req.on('error', reject);
  });
}

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env.mabang-bridge');
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
}

function writeLog(payload) {
  const line = JSON.stringify({ ...payload, sessionId: SESSION_ID, timestamp: Date.now() }) + '\n';
  fs.appendFileSync(LOG_PATH, line, 'utf8');
}

async function main() {
  loadEnv();
  const baseUrl = (process.env.CHATWOOT_BASE_URL || '').replace(/\/$/, '');
  const accountId = (process.env.CHATWOOT_ACCOUNT_ID || '1').trim();
  const token = (process.env.CHATWOOT_API_ACCESS_TOKEN || '').trim();

  if (!baseUrl || !token) {
    writeLog({
      hypothesisId: 'H2',
      location: 'debug-chatwoot-custom-attributes.js',
      message: 'Missing CHATWOOT_BASE_URL or CHATWOOT_API_ACCESS_TOKEN',
      data: { hasBaseUrl: !!baseUrl, hasToken: !!token },
    });
    return;
  }

  const headers = {
    'Content-Type': 'application/json',
    api_access_token: token,
    Authorization: `Bearer ${token}`,
  };

  const trimmed = token.trim();
  const tokenHash = crypto.createHash('sha256').update(trimmed).digest('hex').slice(0, 8);
  writeLog({
    hypothesisId: 'H2',
    location: 'debug-chatwoot-custom-attributes.js',
    message: 'Token loaded',
    data: {
      tokenLength: token.length,
      trimmedLength: trimmed.length,
      hasLeadingTrailingSpace: token !== trimmed,
      tokenHashFirst8: tokenHash,
      envPath: path.resolve(path.join(__dirname, '..', '.env.mabang-bridge')),
      accountId,
    },
  });

  const accountUrl = `${baseUrl}/api/v1/accounts/${accountId}`;
  const accountOut = await httpGet(accountUrl, headers, { captureHeaders: true }).catch(() => ({ status: 0, body: '', headers: {} }));
  writeLog({
    hypothesisId: 'H2',
    location: 'debug-chatwoot-custom-attributes.js',
    message: 'Account API probe (header auth, public URL)',
    data: { accountStatus: accountOut.status, wwwAuthenticate: accountOut.headers && accountOut.headers['www-authenticate'] },
  });

  const directBase = 'http://127.0.0.1:3000';
  const directAccountOut = await httpGet(`${directBase}/api/v1/accounts/${accountId}`, headers).catch(() => ({ status: 0, body: '' }));
  writeLog({
    hypothesisId: 'H6',
    location: 'debug-chatwoot-custom-attributes.js',
    message: 'Account API probe (direct to backend :3000, bypass proxy)',
    data: { directStatus: directAccountOut.status },
  });

  const baseDefUrl = `${baseUrl}/api/v1/accounts/${accountId}/custom_attribute_definitions`;
  const urlWithQueryAuth = `${baseDefUrl}?attribute_model=1&api_access_token=${encodeURIComponent(token)}`;

  let res;
  let body;
  try {
    let out = await httpGet(urlWithQueryAuth, { 'Content-Type': 'application/json' }, { captureHeaders: true });
    writeLog({
      hypothesisId: 'H5',
      location: 'debug-chatwoot-custom-attributes.js',
      message: 'Auth via query param only (no header, bypass Nginx underscore strip)',
      data: { status: out.status },
    });
    if (out.status === 401) {
      const out2 = await httpGet(baseDefUrl + '?attribute_model=1', headers, { captureHeaders: true });
      writeLog({
        hypothesisId: 'H5',
        location: 'debug-chatwoot-custom-attributes.js',
        message: 'Fallback: header auth',
        data: { status: out2.status },
      });
      out = out2;
    }
    res = { status: out.status };
    body = out.body;
  } catch (err) {
    writeLog({
      hypothesisId: 'H2',
      location: 'debug-chatwoot-custom-attributes.js',
      message: 'Fetch error',
      data: { error: String(err.message) },
    });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    payload = { _raw: body };
  }

  if (res.status !== 200) {
    writeLog({
      hypothesisId: 'H2',
      location: 'debug-chatwoot-custom-attributes.js',
      message: 'API returned non-200 (auth or server error)',
      data: { status: res.status, body: body.slice(0, 500), payload },
    });
    return;
  }

  const list = Array.isArray(payload.payload) ? payload.payload : (payload.data || payload.payload || []);
  const count = Array.isArray(list) ? list.length : 0;

  writeLog({
    hypothesisId: count === 0 ? 'H1' : 'H2',
    location: 'debug-chatwoot-custom-attributes.js',
    message: count === 0 ? 'No contact attribute definitions from API (H1: never created)' : 'Contact attribute definitions returned',
    data: {
      status: res.status,
      count,
      attribute_model: 1,
      keys: Array.isArray(list) ? list.map((a) => a.attribute_key || a.key || a.id) : [],
      payload_sample: Array.isArray(list) && list[0] ? { attribute_key: list[0].attribute_key, attribute_display_name: list[0].attribute_display_name } : null,
    },
  });
}

main().catch((e) => {
  fs.appendFileSync(
    LOG_PATH,
    JSON.stringify({
      sessionId: SESSION_ID,
      hypothesisId: 'H2',
      location: 'debug-chatwoot-custom-attributes.js',
      message: 'Script error',
      data: { error: String(e.message) },
      timestamp: Date.now(),
    }) + '\n',
    'utf8'
  );
});
