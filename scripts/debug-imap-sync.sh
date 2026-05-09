#!/usr/bin/env bash
# IMAP 同步诊断：收集 Sidekiq 中 IMAP/邮件渠道相关日志，写入 NDJSON 供分析
# 使用方式：在确认邮箱已收到邮件但 Chatwoot 未同步时，于项目根目录执行 ./scripts/debug-imap-sync.sh

set -e
ROOT="${ROOT:-/root/chatwoot-docker}"
LOG_PATH="${ROOT}/.cursor/debug-bce694.log"
SESSION_ID="bce694"
TS=$(date +%s)000

mkdir -p "$(dirname "$LOG_PATH")"

COMPOSE_CMD="docker compose"
command -v docker-compose >/dev/null 2>&1 && COMPOSE_CMD="docker-compose"
SIDEKIQ_LOGS=$(cd "$ROOT" && $COMPOSE_CMD logs --tail=800 sidekiq 2>&1 || true)

# 假设 A：FetchImap 相关 Job 是否在执行
if echo "$SIDEKIQ_LOGS" | grep -q "FetchImapEmailInboxesJob\|FetchImapEmailsJob"; then
  H_A="fetch_imap_job_seen"
else
  H_A="no_fetch_imap_job"
fi

# 假设 B：是否有 "Error for email channel"（该渠道拉取失败）
if echo "$SIDEKIQ_LOGS" | grep -q "Error for email channel"; then
  H_B="error_for_email_channel"
else
  H_B="no_error_for_channel"
fi

# 假设 C：是否有 IMAP 认证/连接类错误
if echo "$SIDEKIQ_LOGS" | grep -qiE "IMAP.*auth|authenticat.*fail|535|SSL|timeout|enable IMAP|yet to enable"; then
  H_C="auth_or_conn_error"
else
  H_C="no_auth_conn_error"
fi

# 假设 D：是否有 Lock failed / 锁竞争
if echo "$SIDEKIQ_LOGS" | grep -q "Lock failed\|Failed to acquire lock"; then
  H_D="lock_failed_seen"
else
  H_D="no_lock_failed"
fi

# 假设 E：是否出现“请先开启 IMAP”或 IMAP 被禁用类提示
if echo "$SIDEKIQ_LOGS" | grep -q "yet to enable IMAP\|You are yet to enable"; then
  H_E="imap_not_enabled_msg"
else
  H_E="no_imap_disabled_msg"
fi

append_log() {
  local hid="$1"
  local msg="$2"
  local data="$3"
  echo "{\"sessionId\":\"$SESSION_ID\",\"runId\":\"imap-sync-debug\",\"hypothesisId\":\"$hid\",\"location\":\"scripts/debug-imap-sync.sh\",\"message\":\"$msg\",\"data\":$data,\"timestamp\":$TS}" >> "$LOG_PATH"
}

append_log "A" "FetchImap Job 是否执行" "{\"result\":\"$H_A\"}"
append_log "B" "是否有 Error for email channel" "{\"result\":\"$H_B\"}"
append_log "C" "认证或连接错误" "{\"result\":\"$H_C\"}"
append_log "D" "Lock failed 锁竞争" "{\"result\":\"$H_D\"}"
append_log "E" "IMAP 未开启类提示" "{\"result\":\"$H_E\"}"

# 原始错误片段（仅前 500 字符，避免敏感信息）
ERR_LINE=$(echo "$SIDEKIQ_LOGS" | grep -E "Error for email channel|FetchImapEmailsJob.*Error|yet to enable IMAP" | head -1 | sed 's/"/\\"/g' | cut -c1-500)
append_log "raw" "第一条相关错误" "{\"snippet\":\"${ERR_LINE:-none}\"}"

echo "已写入 $LOG_PATH (sessionId=$SESSION_ID)"
exit 0
