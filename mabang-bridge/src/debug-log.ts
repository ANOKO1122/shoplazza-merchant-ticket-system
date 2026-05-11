/**
 * Debug session 52b5d9：NDJSON 写入 DEBUG_LOG_PATH + 上报 ingest（不落盘敏感信息）
 */
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';

/** 默认与 docker-compose / 调试会话一致；可通过 AGENT_DEBUG_SESSION_ID 覆盖 */
const SESSION = process.env.AGENT_DEBUG_SESSION_ID?.trim() || 'def42e';
const INGEST = 'http://localhost:7323/ingest/456b4b9b-9da6-4bd8-a0d9-7e4966fdd0bd';

export function agentDebugLog(payload: {
  hypothesisId: string;
  location: string;
  message: string;
  data?: Record<string, unknown>;
}): void {
  const body = {
    sessionId: SESSION,
    timestamp: Date.now(),
    ...payload,
  };
  const line = JSON.stringify(body);
  const file =
    process.env.AGENT_DEBUG_LOG_PATH?.trim() ||
    process.env.DEBUG_LOG_PATH?.trim();
  if (file) {
    try {
      fs.appendFileSync(file, `${line}\n`);
    } catch {
      /* 容器未挂载或路径不可写时忽略 */
    }
  }
  // #region agent log
  fetch(INGEST, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': SESSION },
    body: JSON.stringify({ ...body, sessionId: SESSION }),
  }).catch(() => {});
  // #endregion
}

const DEBUG_47_SESSION = '47c96a';
const DEBUG_47_INGEST = 'http://localhost:7323/ingest/456b4b9b-9da6-4bd8-a0d9-7e4966fdd0bd';

function debug47LogPath(): string {
  if (fs.existsSync('/bridge-debug')) return '/bridge-debug/debug-47c96a.log';
  return path.join(process.cwd(), '.cursor', 'debug-47c96a.log');
}

/** 调试会话 47c96a：NDJSON 落盘 + ingest（禁止记录 token/邮箱原文） */
export function debugSession47Log(payload: {
  hypothesisId: string;
  location: string;
  message: string;
  data?: Record<string, unknown>;
  runId?: string;
}): void {
  const body = {
    sessionId: DEBUG_47_SESSION,
    timestamp: Date.now(),
    runId: payload.runId ?? 'pre-fix',
    ...payload,
  };
  const line = JSON.stringify(body);
  try {
    fs.appendFileSync(debug47LogPath(), `${line}\n`);
  } catch {
    /* 未挂载 .cursor 时忽略 */
  }
  fetch(DEBUG_47_INGEST, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': DEBUG_47_SESSION },
    body: JSON.stringify(body),
  }).catch(() => {});
}

const DEBUG_3700AB_SESSION = '3700ab';

function debug3700abLogPath(): string {
  if (fs.existsSync('/bridge-debug')) return '/bridge-debug/debug-3700ab.log';
  return path.join(process.cwd(), '.cursor', 'debug-3700ab.log');
}

/** 调试会话 3700ab：索引未命中侧栏排障（仅统计字段，不落邮箱/单号原文） */
export function debugSession3700abLog(payload: {
  hypothesisId: string;
  location: string;
  message: string;
  data?: Record<string, unknown>;
  runId?: string;
}): void {
  const body = {
    sessionId: DEBUG_3700AB_SESSION,
    timestamp: Date.now(),
    runId: payload.runId ?? 'pre-fix',
    hypothesisId: payload.hypothesisId,
    location: payload.location,
    message: payload.message,
    data: payload.data,
  };
  try {
    fs.appendFileSync(debug3700abLogPath(), `${JSON.stringify(body)}\n`);
  } catch {
    /* 未挂载 .cursor 时忽略 */
  }
  fetch(INGEST, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': DEBUG_3700AB_SESSION },
    body: JSON.stringify(body),
  }).catch(() => {});
}
