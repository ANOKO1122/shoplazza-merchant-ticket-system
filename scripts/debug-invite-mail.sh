#!/usr/bin/env bash
# 邀请邮件问题诊断：收集 Sidekiq/Chatwoot 日志并写入 NDJSON 供调试分析
# 使用方式：在发送邀请后于项目根目录执行 ./scripts/debug-invite-mail.sh

set -e
ROOT="${ROOT:-/root/chatwoot-docker}"
LOG_PATH="${ROOT}/.cursor/debug-bce694.log"
SESSION_ID="bce694"
TS=$(date +%s)000

mkdir -p "$(dirname "$LOG_PATH")"

# 兼容 docker-compose 与 docker compose
COMPOSE_CMD="docker compose"
command -v docker-compose >/dev/null 2>&1 && COMPOSE_CMD="docker-compose"
# 收集最近日志（邀请与发信一般在最近 500 行内）
SIDEKIQ_LOGS=$(cd "$ROOT" && $COMPOSE_CMD logs --tail=500 sidekiq 2>&1 || true)
CHATWOOT_LOGS=$(cd "$ROOT" && $COMPOSE_CMD logs --tail=300 chatwoot 2>&1 || true)

# 检查 .env 中 SMTP 相关（不记录密码等敏感内容）
SMTP_PORT=$(grep -E '^SMTP_PORT=' "$ROOT/.env" 2>/dev/null | cut -d= -f2 || echo "")
SMTP_SSL_SET=$(grep -E '^SMTP_SSL=' "$ROOT/.env" 2>/dev/null | cut -d= -f2 || echo "未设置")
HAS_SMTP_ADDRESS=$(grep -E '^SMTP_ADDRESS=' "$ROOT/.env" 2>/dev/null | wc -l)

# 假设 A：邀请/邮件 Job 是否入队（Rails 或 Sidekiq 中是否有 enqueue 或 invite 相关）
if echo "$CHATWOOT_LOGS$SIDEKIQ_LOGS" | grep -qiE 'invite|invitation|InvitationMailer|ActionMailer::MailDeliveryJob'; then
  H_A="enqueue_or_invite_found"
else
  H_A="no_invite_or_mail_job_seen"
fi

# 假设 B：Sidekiq 是否执行了邮件 Job（Perform ActionMailer / Delivered mail）
if echo "$SIDEKIQ_LOGS" | grep -q "ActionMailer::MailDeliveryJob"; then
  H_B="mail_job_executed"
else
  H_B="no_mail_job_in_sidekiq"
fi

# 假设 C：是否有 Net::ReadTimeout、EOFError、535、SSL、认证错误
ERR_SNIPPET=""
if echo "$SIDEKIQ_LOGS" | grep -q "Net::ReadTimeout"; then
  ERR_SNIPPET="Net::ReadTimeout"
elif echo "$SIDEKIQ_LOGS" | grep -q "EOFError"; then
  ERR_SNIPPET="EOFError"
elif echo "$SIDEKIQ_LOGS" | grep -qE "535|authenticat|SSL|openssl|ReadTimeout"; then
  ERR_SNIPPET=$(echo "$SIDEKIQ_LOGS" | grep -oE "535|authenticat|SSL|openssl|ReadTimeout" | head -3 | tr '\n' ' ')
else
  ERR_SNIPPET="none_seen"
fi

# 假设 D：465 端口但未设置 SMTP_SSL
if [ "$SMTP_PORT" = "465" ] && [ -z "$SMTP_SSL_SET" ] || [ "$SMTP_SSL_SET" = "未设置" ]; then
  H_D="port_465_without_SMTP_SSL"
else
  H_D="smtp_ssl_ok_or_not_465"
fi

# 假设 E：message_id for nil 或其它 Mailer 异常
if echo "$SIDEKIQ_LOGS$CHATWOOT_LOGS" | grep -q "message_id.*nil\|undefined method.*nil"; then
  H_E="message_id_nil_error"
else
  H_E="no_message_id_nil"
fi

# 写入 NDJSON（每行一个 JSON，便于分析）
append_log() {
  local hypothesis_id="$1"
  local message="$2"
  local data="$3"
  echo "{\"sessionId\":\"$SESSION_ID\",\"runId\":\"invite-debug\",\"hypothesisId\":\"$hypothesis_id\",\"location\":\"scripts/debug-invite-mail.sh\",\"message\":\"$message\",\"data\":$data,\"timestamp\":$TS}" >> "$LOG_PATH"
}

# 转义 data 中的字符串为 JSON 安全（简单用 jq 或手写）
data_a="{\"result\":\"$H_A\"}"
data_b="{\"result\":\"$H_B\"}"
data_c="{\"result\":\"$ERR_SNIPPET\"}"
data_d="{\"smtp_port\":\"$SMTP_PORT\",\"smtp_ssl\":\"$SMTP_SSL_SET\",\"result\":\"$H_D\"}"
data_e="{\"result\":\"$H_E\"}"

append_log "A" "邀请/邮件 Job 是否入队" "$data_a"
append_log "B" "Sidekiq 是否执行邮件 Job" "$data_b"
append_log "C" "Sidekiq 错误类型" "$data_c"
append_log "D" "465 端口且未设 SMTP_SSL" "$data_d"
append_log "E" "message_id nil 等 Mailer 异常" "$data_e"

# 仅记录是否包含关键错误行（避免大段文本破坏 JSON）
HAS_MAILER_ERROR=$(echo "$SIDEKIQ_LOGS" | grep -c "ActionMailer::MailDeliveryJob.*Error\|Job raised exception" 2>/dev/null || echo "0")
append_log "raw" "Sidekiq 中邮件 Job 错误条数" "{\"mailer_error_count\":\"$HAS_MAILER_ERROR\"}"

# 假设 F：最近是否有成功投递（Delivered mail = 修复生效）
if echo "$SIDEKIQ_LOGS" | grep -q "Delivered mail"; then
  H_F="delivered_ok"
else
  H_F="no_delivered_in_tail"
fi
append_log "F" "最近日志中是否有 Delivered mail" "{\"result\":\"$H_F\"}"

echo "已写入 $LOG_PATH (sessionId=$SESSION_ID)"
exit 0
