# IMAP 同步问题排查

当邮箱已收到邮件但 Chatwoot 收件箱未同步时，可参考本文档。

## 诊断脚本

在项目根目录执行：

```bash
./scripts/debug-imap-sync.sh
```

然后查看 `.cursor/debug-bce694.log`（或脚本输出的 log 路径）。若出现 `"imap_not_enabled_msg"` 或 raw 片段中含 **"You are yet to enable IMAP for your account"**，说明 Zoho（或当前邮件服务商）对该邮箱**未开启 IMAP 访问**。

## 常见原因与处理

| 日志/现象 | 原因 | 处理 |
|-----------|------|------|
| Error for email channel - X : You are yet to enable IMAP for your account | 该邮箱在服务商侧未开启 IMAP | 在 Zoho Mail 设置 → 邮件帐户 → 该邮箱 → 勾选「启用 IMAP 访问」并保存 |
| Lock failed / Failed to acquire lock | 多渠道并发拉取时的锁竞争 | 一般可忽略；若某渠道长期无邮件，可再保存一次该渠道的 IMAP 设置以重试 |
| 认证失败 / 535 | IMAP 密码错误或需使用应用专用密码 | 在 Zoho 核对密码；若开启两步验证，使用应用专用密码 |

## Zoho Mail 开启 IMAP 步骤（简要）

1. 登录 Zoho Mail 网页版 → 设置 → 邮件帐户。
2. 选择对应邮箱（如 service@alychic.shop）→ 在 IMAP 区域勾选「启用 IMAP 访问」→ 保存。
3. 等待约 1～2 分钟让 Chatwoot 再次拉取（`IMAP_SYNC_INTERVAL=60`）。
