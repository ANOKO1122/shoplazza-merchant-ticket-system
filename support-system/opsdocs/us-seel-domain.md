# us-seel.com 顾客保障入口

## 当前状态（2026-11-04 UTC）

`us-seel.com` 的 A 记录已指向 `104.194.95.40`。顾客 HTTPS 入口已启用，
Let's Encrypt 独立证书有效至 **2027-02-02**。公网 `/`、`/protection` 及两份
顾客资源返回 200；匿名订单 API 返回 401；后台、工单、uploads、mailpit 返回 404；
顾客 SNI 携带后台 Host 返回 421；原后台登录页仍返回 200。

真实上游验证发现 Express 静态目录 `public/protection` 会先将同名页面重定向至
`/protection/`。顾客 vhost 的两个页面入口均直达应用根路由，保留 query；应用也将
`/protection` 页面路由移至静态中间件前。不要恢复旧的根路径转发 `/protection`。

激活前的生产配置备份保存在 `/tmp/us-seel-activation-20261104T032656Z/`，
包含 HTTP ingress、SNI router、support vhost 和两个 certbot 脚本，不含私钥。
续期脚本已部署并重启。两次 staging 续期演练均在连接 ACME 测试服务时收到
`ConnectionResetError(104)`，尚未验证演练成功；正式证书签发和公网 TLS 已验证成功。
后续需在测试服务可达时重新运行 `certbot renew --cert-name us-seel.com --dry-run --no-random-sleep-on-renew`，
不得加 `--run-deploy-hooks`，避免把测试证书部署到生产。

域名的 MX/TXT 尚未配置。网站 HTTPS 就绪不等于邮箱可用。申请通知发送默认关闭，
专用发信账号配置或用户明确允许使用现有账号后才启用；不自动复用工单发信身份。

## 现有入口和文件

生产目录：`/root/work/shoplazza-merchant-ticket-system/support-system`。

| 入口 | 当前宿主机配置 | 顾客域名准备内容 |
| --- | --- | --- |
| 公网 80，`fb-ad-nginx` | `/root/work/FB-Ad-Logic-Engine/deploy/nginx-fb-ad-docker.conf` | `nginx/us-seel-http-ingress.conf`：按域名转发到 `172.17.0.1:4000` |
| 公网 443，`stream-router` | `/root/work/ronghe-platform/nginx/stream-router.conf` | `nginx/us-seel-stream-map.conf`：现有 SNI map 中增加一行 |
| support 4000/8443 | `nginx/support-nginx.conf` | 现有后台 HTTPS vhost 增加仅针对顾客 SNI 的跨 Host 拒绝 |
| 正式顾客 vhost | `nginx/us-seel-vhosts.conf` | 已加入生产 support 配置的 HTTP/HTTPS server |
| 待签发 HTTP | `nginx/us-seel-http-pending.conf` | 仅 ACME 可用，其余请求返回待上线状态；签证后替换为正式 vhost |
| 证书部署/续期 | `certbot/deploy.sh`、`certbot/renew.sh` | 按证书 lineage 分开部署；已有顾客证书每 12 小时检查续期 |

生产 support 配置通过标记块保存顾客 vhost；源码模板为 `nginx/us-seel-vhosts.conf`。
不要改变其他域名、stream upstream、监听端口或默认路由。

## 顾客域名边界

HTTPS 仅反代 `/`、`/protection`、`/protection/photo-requirements`、
`/protection/help`、`/email-preferences`、`/assets/customer-protection.js`、
`/assets/customer-protection.css`、`/assets/protection-help.css`、
`/assets/protection-location-ios.png`、
`/assets/protection-location-android.png`、`/assets/protection-photo-guidelines.png`、
`/assets/protection-camera-ios.png`、`/assets/protection-camera-android.png`、
`/assets/protection-example-package.jpg`、`/assets/protection-example-item.jpg` 和
`/api/protection/` 前缀。八篇公开帮助文章由 `/protection/help?article=...` 的
固定白名单选择，`/protection/photo-requirements` 保留为破损照片文章入口。
五张教学图及两张照片示例为固定公开静态图片；不要
扩展为整个 assets 目录或任意图片路径。
其他路径直接返回 404，包括 `/api/admin`、`/thinkpro-admin`、`/uploads`、
`/api/support`、`/mailpit` 和其他 assets。一般顾客 API 请求体积上限 64 KiB；
仅精确 `/api/protection/evidence` 允许 26 MiB multipart 请求，应用再校验单文件
25 MiB 上限。

顾客 TLS 连接若提交后台 Host，后台 vhost 返回 421，避免切换 vhost 绕过白名单。
顾客错误日志关闭，访问日志不记录 query 或 Referer，响应使用 `Referrer-Policy:
no-referrer`。证书保存在独立目录 `nginx/ssl/us-seel.com/`；私钥权限 600，禁止提交。

## DNS 恢复后的激活顺序

1. 先保存上述三个生产 Nginx 配置和两个 certbot 脚本的备份。对比最新生产配置与
   工作树，保留此后新增的其他域名及后台配置。修改 bind-mounted 文件时应原地写入
   （例如 `cat source > destination`），不要用替换 inode 的 rename 操作。
2. 在公网 HTTP 配置增加 `us-seel-http-ingress.conf` 的 server。在生产 support 配置
   增加 `us-seel-http-pending.conf` 的 server。分别执行
   `docker exec fb-ad-nginx nginx -t` 和
   `docker exec support-system-support-nginx-1 nginx -t`，通过后才对相应容器执行
   `nginx -s reload`。此时不改 443 的 SNI map。
3. 在 `nginx/acme-challenge/.well-known/acme-challenge/` 创建一个无敏感内容的随机
   探测文件，通过真实公网 `http://us-seel.com/.well-known/acme-challenge/<文件名>`
   确认返回该内容，再删掉探测文件。确认证书验证会到达本服务器后再申请。
4. 原地部署两个 certbot 脚本，然后执行：

   ```sh
   docker exec support-system-support-certbot-1 certbot certonly \
     --webroot -w /var/www/certbot \
     -d us-seel.com --cert-name us-seel.com \
     --non-interactive --agree-tos --register-unsafely-without-email \
     --keep-until-expiring --deploy-hook /opt/deploy.sh
   ```

   成功的 deploy hook 将顾客证书复制到 `/etc/nginx/ssl/us-seel.com/`，后台证书路径
   保持独立。不要在工作树保存任何证书、私钥或 ACME account 文件。
5. 将生产 support 配置的 pending server **替换**为 `nginx/us-seel-vhosts.conf`
   中完整的两个顾客 vhost，并加入主配置中后台 HTTPS 块的顾客 SNI 421 检查。核对无重复 server，运行
   `nginx -t` 后重载 support-nginx。
6. 将 `us-seel-stream-map.conf` 中那一行加入现有 `$ssl_preread_server_name` map，
   执行 `docker exec stream-router nginx -t`，通过后执行
   `docker exec stream-router nginx -s reload`。不要创建第二份 map 或修改 upstream。
7. 重启 `support-system-support-certbot-1`，使其读取更新后的续期循环；若曾重建
   support-nginx，必须同时重建 certbot，以重新加入 Nginx 的 PID namespace。
   后续证书由 certbot 每 12 小时检查，成功续期后仅 HUP Nginx。执行一次：

   ```sh
   docker exec support-system-support-certbot-1 certbot renew \
     --cert-name us-seel.com --dry-run
   ```

   dry-run 不增加 `--run-deploy-hooks`，不向生产部署测试证书。
8. 不使用 `curl -k` 验证公网证书。确认 `/` 与 `/protection` 返回顾客页面、两个
   assets 正常加载、无 token 的只读 API 返回预期错误而非其他应用页面。确认后台/
   上传/客服路径均为 404，并用 SNI `us-seel.com`、Host
   `server.clientservice-center.com` 验证返回 421。验证原后台域名仍正常；不要发送
   真实订单变更、邮件或顾客申请。

## 回退

恢复备份时同样原地写入配置，先 `nginx -t` 再重载对应容器。删除 SNI map 中仅
`us-seel.com` 的新增行，撤掉该域名的 HTTP ingress 与 support vhost，并恢复两份
certbot 脚本后重启 certbot。不要删除后台证书或修改其他域名。未启用的顾客证书可
保留在忽略目录中，避免紧急回退时进行不必要的证书删除。
