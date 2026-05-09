# Chatwoot 系统发信配置（第三方 SMTP）

当前 `.env` 已改为第三方 SMTP 模板，需填写真实密钥后**重启 chatwoot 和 sidekiq** 才能发邀请/通知邮件。

---

## 选项 A：SendGrid（国际）

1. 注册 [SendGrid](https://sendgrid.com/)，在 **Settings → API Keys** 创建 API Key（需发信权限）。
2. 在 **Settings → Sender Authentication** 验证你的发信域名或单邮箱。
3. 编辑项目根目录 `.env`，修改以下三处（其余保持不动）：
   - `MAILER_SENDER_EMAIL=` 改为你在 SendGrid 验证过的邮箱（如 `noreply@yourdomain.com`）。
   - `SMTP_PASSWORD=` 改为你的 API Key（形如 `SG.xxxxx`）。
   - 若发信域名已验证，可设置 `SMTP_DOMAIN=yourdomain.com`。
4. 执行：`docker-compose up -d --force-recreate chatwoot sidekiq`。

---

## 选项 B：阿里云邮件推送（DirectMail）

1. 登录 [阿里云 邮件推送](https://www.aliyun.com/product/directmail)，开通服务。
2. 在控制台创建**发信地址**，并设置 **SMTP 密码**（非登录密码）。
3. 编辑 `.env`，将 SMTP 相关改为（请替换实际值）：
   ```bash
   SMTP_ADDRESS=smtpdm.aliyun.com
   SMTP_PORT=465
   SMTP_DOMAIN=aliyun.com
   SMTP_AUTHENTICATION=login
   SMTP_OPENSSL_VERIFY_MODE=peer
   SMTP_SSL=true
   SMTP_OPEN_TIMEOUT=30
   SMTP_READ_TIMEOUT=30
   MAILER_SENDER_EMAIL=你的发信地址@xxx.com
   SMTP_USERNAME=你的发信地址@xxx.com
   SMTP_PASSWORD=控制台里设置的SMTP密码
   ```
   删除或注释掉 `SMTP_ENABLE_STARTTLS_AUTO`（465 不需要）。
4. 执行：`docker-compose up -d --force-recreate chatwoot sidekiq`。

---

## 验证

配置并重启后，在 Chatwoot 后台对**新邮箱**发送一次「邀请成员」，约 30 秒后检查是否收到邮件。  
可选：在项目根目录执行 `./scripts/debug-invite-mail.sh`，若日志中假设 F 为 `delivered_ok` 表示发信成功。
