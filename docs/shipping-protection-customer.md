# 顾客运输保障门户

## 入口与当前范围

顾客正式域名固定为 `https://us-seel.com`，访问链接形如
`https://us-seel.com/protection#access=…`。后台仍在原工单域名，入口为
`/thinkpro-admin/protection`。域名 DNS/HTTPS 已启用，配置及激活步骤见
`support-system/opsdocs/us-seel-domain.md`。不要把工单系统的全局 public base URL
改为赔付域名；两者独立。

顾客页面已连接真实接口，包括订单与包裹、固定 SP 保障编号、收到/未收到分支、
问题类型、商品数量、申请预估金额、图片/视频、定位、确认提交和申诉历史。
未收到包裹的新申诉必须提供定位；已收到包裹分支仍为可选。
同一 SP 下可有多个 CL；拒绝不占用额度，重提产生新 CL。
submitted/reviewing/needs_info 状态支持在原 CL 下继续补资料。

审核后台能查看顾客问答、所选数量、附件、定位和补充说明。**顾客可见回复**与
**处理备注（内部）**分开；负责人、内部审计、外部付款凭据不会进入顾客 DTO。
审批金额受所选数量、商品余额及订单剩余额度约束。退款/取消资料未核实的订单
继续沿用人工核验阻断，不凭不完整数据自动批准。

没有退货、自动打款或退款 API。保障时限与完成后服务商品履约已配置，见
`support-system/opsdocs/protection-service-rules.md`；申诉状态通知使用独立发信地址，见
`support-system/opsdocs/protection-notifications.md`。发货、完成与申请状态更新邮件已接入自动通知。
店匠 `finished` 只展示商家系统完成记录，不冒充承运商真实签收时间。

## 邮件与访问链接

原后台「邮件模板」新增 **完成模板（物流保障）**，key 为
`protection_completion_notice`，可编辑、预览、保存预设和恢复默认。
初始化使用 `ON CONFLICT DO NOTHING`，不会覆盖运营人员已保存的模板。
`protection_link`、`protection_no`、`tracking_number`、`carrier` 为新增变量；
默认预览使用合成资料和不含访问权限的 us-seel.com URL。

后台「保障订单」详情可主动生成、复制并打开顾客访问链接。生成不会发送邮件。
自动邮件流程调用 `createProtectionAccessLink(protectionOrderId)`，将其结果传给
`protection_link`，不能调用工单 `bt_`/`ta_` 令牌生成器。保障邮件使用
`support@us-seel.com` 独立发送；最新启用时间与队列规则以
`support-system/opsdocs/protection-notifications.md` 为准。

## 安全边界

- `pa_` 随机访问令牌在数据库中只保存 SHA-256，绑定一个保障订单及当前邮箱，
  新签发链接默认 90 天有效，历史链接保持原到期日；`ps_` 会话最多 12 小时，邮箱改变或令牌撤销立即失效。
  这两个时间属于访问凭证有效期，不代表赔付申请期限。
- token 仅通过 URL fragment 传入，脚本立即移除并以 POST 换取 HttpOnly、
  SameSite=Lax、HTTPS Secure 的 host-only cookie，path 为 `/api/protection`。
- 每个标签页将公开 SP 编号保存在 sessionStorage。首次兑换、刷新及所有写入
  通过 `X-Protection-Reference` 绑定当前订单，防止另一标签页切换 cookie 后误单。
  sessionStorage 不保存访问 token。
- 状态变更要求同源和 JSON；上传要求同源、有效顾客会话及对应 SP。
  创建、补资料与上传分别有幂等键。数量/金额/附件归属由服务端检查并锁定订单。
- us-seel.com 在 Express 和预备 nginx 配置中仅允许顾客页面、两个静态 bundle
  及 `/api/protection/`，其他后台、工单和公开 uploads 路径返回 404。

## 私有证据

默认持久化位置为 `/app/protection-data/customer-evidence`，复用现有
protection-data 挂载；不会存进公开 `/uploads`。

- JPEG/PNG/WebP 图片由 sharp 解码并重编码为 WebP，去除元数据，限制像素。
- MP4/WebM 由 ffprobe 验证真实视频流，拒绝不支持的格式与伪装内容。
- 每次最多 6 个文件、每个 25 MiB、总计 100 MiB；单合同总存储上限 500 MiB。
- 下载必须匹配顾客合同或有效客服身份，视频支持 Range。没有公开对象 URL。
- 上传使用 UUID 幂等键及源文件摘要；重试不重复计入名额。移除、取消草稿会
  清理未提交附件；服务端每小时清理超过 24 小时的未提交记录。
- 定位只在顾客主动点击后采集，提交时才发送坐标、精度与采集时间。未收到包裹
  的三类新申诉在前端和接口都要求有效定位；拒绝、超时或移除定位后不能提交。
  已收到包裹分支仍可跳过，旧申诉查看与补资料不受影响。浏览器坐标可被伪造，
  只能作为辅助证据，不能作为顾客诚实或包裹签收的独立证明。

### 2026-11-08 定位结果与权限指引（历史实现）

顾客采集页、提交确认页及已提交申诉详情均展示经纬度、设备报告的估计精度和采集
时间；客服页面也明确标为设备估计，不能解释成已核实的实际误差范围。后端继续保存
原始坐标，没有坐标平均、补偿偏移或硬编码精度。经纬度按 WGS84 解释，国内地图
可能采用不同坐标系，地图偏移不能仅凭截图归因于采集误差。

采集改为 `watchPosition`，保持高精度请求与禁用缓存，最多运行 20 秒。在本次请求
的有效新鲜读数中保留设备报告误差较小的一次；至少观察 5 秒、取得两个不同时间的
读数且最佳估计不大于 20 米时可提前结束。这个数值仅是结束搜索的目标，不是实际
精度保证。顾客可主动使用当前读数，也可重新获取；重新获取替换此前保存的位置。
结束、取消、离开步骤、切到后台或组件卸载均清理监听，迟到结果不会重新启动采集。

定位权限帮助使用用户提供的两张英文原图，提供 iOS／Android 标签、图片放大和
可读文字步骤，说明应用级／网站级授权及 Precise Location。失败时自动展开帮助，
重试保留当前申诉内容，不刷新整页。公开路径仅增加两张指定 PNG，其他资产和证据
路径的访问边界不变。

依据：[W3C Geolocation](https://www.w3.org/TR/geolocation/)、
[Apple Location Services](https://support.apple.com/en-us/102515)、
[高德坐标系说明](https://developer.amap.com/api/javascript-api-v2/guide/transform/convertfrom)。

本次部署镜像：`support-bridge:protection-location-guidance-20261108`；可回滚至
`support-bridge:protection-qq-location-20261104`。后端常规测试 475 通过、16 个环境
依赖用例跳过，前端 31 通过；桌面／手机浏览器覆盖读数改善、手动确认、权限拒绝、
后台／离开步骤停止采集、翻译后的教程标签切换、图片放大与提交确认。线上验证两张
原图完整加载、顾客路由与后台隔离。测试使用模拟定位，不代表已验证实体手机的
实际误差。未创建真实申诉或重新发送邮件。

### 2026-11-09 移动端相机与 Chrome 定位修正

定位当前使用 `watchPosition` 的首个有效、新鲜读数，保持
`enableHighAccuracy: true`、`maximumAge: 0`、`timeout: 8000`。用户点授权前
不再运行页面自设的 8 秒计时器；按 [W3C Geolocation](https://www.w3.org/TR/geolocation/)
规范，浏览器的定位超时只计算获取坐标的时间，不计算等待页面可见或用户授权的时间。
授权成功仍可能因设备定位服务、信号或网络而没有可用坐标；超时后可重试，未收到
包裹分支仍必须取得定位才能提交。`enableHighAccuracy` 只是请求高精度的提示，
Chrome／系统的“精确位置”选择由用户控制，网页不能固定或越过该选择。

Android／iPhone 手机浏览器的破损举证入口现在使用
`<input type="file" accept="image/*" capture="environment">` 请求后置系统相机，
返回后在页面预览、重拍或采用，再沿用绑定订单／会话／类别的短期拍摄凭证上传。
桌面浏览器仍使用下方描述的 `getUserMedia()` 页面内预览。移动端浏览器或系统
可能提供相册选择；[HTML Media Capture](https://www.w3.org/TR/html-media-capture/)
将 `capture` 定义为请求方式，不能保证只来自现拍。后台的拍摄会话
记录与图片处理仍只作为审核辅助，不把来源标记当成照片真实性证明。其他问题
分支仍使用普通附件上传。

自动化验证覆盖定位授权前等待、浏览器超时、取消／迟到回调、手机文件选择回到
页面后的预览和拍摄凭证上传。桌面 Chromium 的手机模拟只能验证网页流程，不能
代替实体 Android Chrome 或 iPhone 相机应用的最终验收。

### 2026-11-09 破损照片指引与摄像头教程

破损举证的四种拍照类别横向排列；手机屏幕可左右滑动，商品破损照片仍为新申请
必需，其余类别可补充。页面的 Photo guidelines 仅在鼠标悬停文字按钮时展开，
也可用键盘或手机点按打开；图片适配弹窗宽度，图片框内不出现滚动条，并保留
查看原图入口。

参考图片作为固定公开教学资源放在 `/assets/protection-photo-guidelines.png`、
`/assets/protection-camera-ios.png` 和 `/assets/protection-camera-android.png`。
摄像头帮助按 iOS／Android 切换并可放大。iOS 图展示 Chrome 的系统权限路径，
Android 图展示 Chrome 的网站摄像头设置；手机系统相机选择器可能使用不同权限，
教程仅在浏览器请求摄像头访问或相机无法打开时作为排查辅助。界面、应用路由和
Nginx 只放行这三张指定教学图，不放开其他 assets 或顾客私有证据。

参考图中的商品及包装只是拍照示例，不改变本系统每次最多 6 张、至少 1 张破损
商品照片、仅退款申请及人工例外的既有业务规则。

### 2026-11-10 权限教程样式与照片指引尺寸

定位和摄像头权限教程统一使用卡片内的 iOS／Android 分段切换与右上角放大图标，
放大后仍可左右滚动查看完整步骤。Photo guidelines 的悬停触发范围只覆盖文字
按钮，不再覆盖整行；示例图按弹窗宽度完整显示，若需放大细节可打开原图。

### 2026-11-10 竖拍预览与证明文件说明

手机相机返回的照片预览按图片原始宽高比显示，不再被固定 4:3 容器和 310px 高度
截短；测试覆盖 3:4 竖拍照片。破损申请的举证区标题为 Upload supporting documents，
“Learn more about the supporting documents” 在新标签页打开本站公开说明页
`/protection/photo-requirements`。该页只说明照片类别、清晰度和无法使用相机时的
文字说明，示例图片来自用户指定的公开参考文章；不照搬该文的申请期限、处理标准。

Photo guidelines 与 “I cannot use a camera” 位于 Take photos of the damage 标题旁。
新申请选择无法使用相机后，拍照入口替换为文字原因输入，不再要求上传照片；原因
仍需至少 10 个字符并进入人工审核。上传或拍摄进行中暂不能切换；若在已附照片
后切换，照片从本次申请中移除。补充资料保留原有仅文字或继续拍照的行为。

### 破损照片的现场拍摄

以下是 2026-11-03 的页面内拍摄实现；当前手机入口见上方 2026-11-09 更新。
桌面浏览器仍在页面内调用 `getUserMedia()`，优先使用后置摄像头，只请求视频流，
不请求麦克风。顾客拍摄静态照片后可以预览、重拍、采用照片；采用后才进入现有
私有上传流程并转为 WebP。破损新申诉及其补充资料不显示普通附件入口。
其他问题仍使用原有图片/视频上传方式。

拍摄类别为商品破损处、外包装、运输标签、其他照片。新破损申诉至少需要一张
商品破损处照片；若设备、浏览器或权限原因导致无法拍摄，可以填写不少于 10
字符的原因交人工审核。例外原因在顾客确认页与后台保留，不代表自动通过。
补资料允许只发文字；如有新附件，必须来自相同拍摄流程。历史附件继续可读。

服务端先发出绑定当前合同/会话/类别的短期拍摄凭证，接收图片时原子记录凭证
使用情况及上传幂等键，防止跨合同使用、过期新上传及重复消费。后台可见拍摄
类别、服务器发起和接收时间。这些字段证明使用了该提交流程，**不能证明照片
真实，也不是 AI 图片检测**；虚拟摄像头、翻拍屏幕或伪造客户端请求仍需人工
结合其他证据审核。原照片 EXIF 不作为验真依据。

权限教程使用英文示意图，覆盖 iPhone Safari、iPhone Chrome 和 Android Chrome；
实际菜单名称可能随系统版本变化。离开拍摄步骤、关闭窗口或切到后台会停止
摄像头，未回答权限弹窗时离开也不会在随后授权后继续后台采集。

`Permissions-Policy` 仅允许本站摄像头和定位，麦克风仍禁用。公开环境需要
HTTPS；us-seel.com 已启用可信证书。不能把 HTTP IP 地址
当作可用的手机相机生产入口。

相关设置：

| 环境变量 | 默认 / 用途 |
| --- | --- |
| `SUPPORT_PROTECTION_PUBLIC_BASE_URL` | `https://us-seel.com`，与工单 public URL 独立 |
| `SUPPORT_PROTECTION_EVIDENCE_DIR` | protection-data 下的 customer-evidence |
| `SUPPORT_PROTECTION_FFPROBE` | `ffprobe`，运行镜像已安装 ffmpeg |
| `SUPPORT_PROTECTION_ALLOW_LOCAL_HTTP` | 仅本地预览为 true；生产不启用 |

## 代码位置

- 顾客 React/TS：`support-system/frontend/customer-protection/`
- 独立 HTML：`support-system/public/customer-protection.html`
- 客户端接口、令牌、schema、证据：`support-system/src/protection-customer-*.ts`
- 自有邮件模板：`support-system/src/protection-email-template.ts`
- 后台证据和安全链接：`support-system/frontend/protection/CustomerSubmission.tsx`
- 域名应用边界：`support-system/src/protection-host.ts`

## 验证

合成测试订单位于隔离 PostgreSQL，后台定时任务关闭，未向真实顾客发送邮件或
创建申诉。完整测试后端 404 通过、11 个依赖独立 DB 的用例跳过，前端 12 通过，
安全检查和 TypeScript/生产构建通过；另单独运行新顾客 PG/HTTP/真实 MP4/WebM
13/13 和原保障 PG 生命周期 9/9。

真实浏览器覆盖两种问题分支、两件商品只申请一件的金额、定位拒绝、私有图片及
视频上传/Range、连续补资料、客服公开回复与内部备注隔离、拒绝后同 SP 新 CL、
多标签页与整页刷新订单绑定、取消六文件后继续上传、手机无横向溢出，以及模板
编辑和桌面/手机邮件呈现。独立 reviewer 发现的问题已修复后复测。

界面截图和渲染预览保存在工作树忽略目录 `.impeccable/customer-review/`，只含
合成数据，不随应用发布。

## 本次发布

2026-11-03 已部署 bridge 镜像 `support-bridge:protection-customer-20261103`，
生产 compose override 已指向该镜像，并保留原 protection-data 持久化挂载。
页面/静态资源在线检查通过；未登录的顾客 API 返回 401，顾客 Host 请求后台
返回 404。只读检查确认新模板存在、保障邮件任务为 0、真实顾客会话和申诉为 0。
测试数据没有写进生产库。

本次只重建 bridge 容器，未替换或重载生产 nginx/certbot 配置；us-seel.com
公开解析与可信 HTTPS 仍待用户后续处理。可回滚到
`support-bridge:pre-protection-customer-20261103`，新增表/字段对旧后台兼容。

### 2026-11-03 相机流程更新

当前运行镜像更新为 `support-bridge:protection-camera-20261103`，回滚标签为
`support-bridge:pre-protection-camera-20261103`。本次也修复了历史商家登记申诉
收到顾客补充材料后，审核后台未显示这些材料的问题；内部描述仍不会进入顾客页面。

最终验证：后端常规测试 405 通过、11 个依赖隔离 DB 的用例跳过；顾客/相机
专项 17/17、原后台兼容专项 17/17、前端 17/17 全通过，专项包含真实 MP4/WebM
校验。构建和独立代码复审通过。浏览器通过模拟摄像头实际走通授权、预览、重拍、
上传、离开步骤停流、拒绝授权后的人工审核、补资料与其他原因普通上传，并核对
桌面/手机布局和后台字段；这不等同于已在实体 iPhone/Android 设备上验收。

发布后只读验证健康接口、顾客页面/新 bundle、同源摄像头响应头、匿名 API
拒绝和顾客域名后台隔离。生产顾客申诉、拍摄会话及证据均为 0；未写入测试材料。
DNS/TLS、真实自动邮件与保障履约规则保持此前的待办状态。
