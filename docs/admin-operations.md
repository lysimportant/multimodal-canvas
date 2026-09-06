# 管理后台运行与验收

本次实现使用既有 React、Fastify、Prisma 和资源存储。正式数据和正式容器尚未升级；以下发布步骤是执行说明，不是已经执行的发布记录。当前进度与最终证据以 [实施检查点](../IMPLEMENTATION-CHECKPOINT.md) 为准。

## 页面与账户

- `/auth/login`、`/auth/register`、`/auth/verify`：独立登录、注册、邮箱验证码页面。注册后必须切到验证码页确认，成功后返回工作台；普通登录可继续已校验的站内返回页面。旧登录侧栏已移除。

- `/admin`：服务端尚未初始化时直接显示管理员配置表单，完成邮箱验证后原子创建管理员并保存永久初始化标记。已有管理员的旧部署会沿用原账户。刷新、清缓存、换浏览器或管理员数量变化不会重开初始化。
- `/admin/users`：管理员创建普通用户、修改业务资料、禁用/恢复、发起改邮箱及重置密码。邀请用户在验证邮箱并设置密码之前不能登录。
- `/admin/resources`：先选择用户分组，再查询该用户资源。缺失或冲突归属进入管理员专用的待归属组，不自动归给第一位管理员。
- `/account/profile`、`/account/security`、`/resources`、`/runs`：个人资料、密码/邮箱/会话、个人跨项目资源及任务。普通用户只获取自己的内容。
- `/admin/audit`、`/admin/runs`、`/admin/system`、`/admin/settings/email`：审计、全站任务、实际服务状态和脱敏邮件状态。资源支持预览、版本、鉴权下载、名称/标签编辑及归档/恢复。

所有页面权限也在 API 执行。管理员对其他用户资源的访问使用专用管理接口，不会隐式改变资源所有者；本次没有开放管理员代跑、跨用户迁移、永久删除或批量覆盖。

头像只打开账户菜单；“退出登录”为独立命令。个人资料与会话更新保持当前账户，前一账户的晚到请求不能重填后来账户的项目缓存或恢复旧会话。访问令牌默认 15 分钟，开放页面在临近到期时续期，绝对期限为 7 天；重新认证不会自动重放项目创建或收费生成请求。

## 邮件配置

用户提供的 `email.txt` 为 dotenv 格式。必需字段：`EMAIL_HOST`、`EMAIL_PORT`、`EMAIL_SECURE`、`EMAIL_USER`、`EMAIL_PASS`、`EMAIL_FROM`。可选 `EMAIL_PROXY` 使用 HTTP/HTTPS CONNECT；TLS 证书校验始终开启。缺配置、投递失败、等待验证和已激活分别显示，不把创建账户成功当作邮件送达。

Windows 的现有桌面文件可以通过当前终端环境引用，文件内容不复制进仓库：

```powershell
$env:MC_EMAIL_FILE = Join-Path ([Environment]::GetFolderPath('Desktop')) 'email.txt'
# 只有邮件链接与实际入口不同时才显式覆盖，例如本机 HTTPS。
$env:MC_APP_PUBLIC_URL = 'https://localhost:8443'
```

Linux 使用部署者管理的私有环境文件路径设置 `MC_EMAIL_FILE`。Compose 只把此文件注入 API，不注入 Web 或 Worker。邮件链接默认采用 `MC_PUBLIC_ORIGIN`，本机采用实际 HTTP 端口，也可由 `MC_APP_PUBLIC_URL` 显式覆盖。不要在共享终端输出完整 `docker compose config` 或容器环境，因为它们可能包含邮件凭据。

公网首次初始化需在同一个私有配置文件设置随机的 `ADMIN_SETUP_TOKEN`，由部署者在初始化表单输入；未配置时仅回环请求可以提交初始化。初始化完成后该接口永久关闭。已有账户要复用为管理员时，先完成邮箱验证，再按 [Docker 运行文档](docker-desktop.md) 的受控管理员提升命令处理；不要批量改写账户角色或绕过验证。

验证码绑定邮箱和用途，10 分钟有效、最多 5 次错误尝试、重发间隔 60 秒，持久化内容为 HMAC 摘要。注册、邀请、换邮箱和重置密码的验证码不可混用。邮件接收器接受发送不等于到达收件箱，管理页使用相应的投递状态描述。

本机实际 SMTP/TLS/认证握手已通过，使用已有系统代理解决 Gmail 直连超时；未发送真实邮件。自动审批曾拒绝“载入真实邮件配置并在后台启动预览服务”，未绕过该拒绝。当前普通预览 API 没有载入真实 SMTP，完整业务验收使用隔离测试邮件接收器。

## 隔离预览

运行时：Node 24.12.0、pnpm 11.19.0。使用已存在的隔离 PostgreSQL 端口 19432，在独立数据库 `admin_review` 中运行；模型使用 mock，文件进入 `.data/admin-review-assets`，不访问正式数据库或真实 Provider。脚本内的认证信息只适用于合成验收环境，不能用于正式部署。

```powershell
node scripts/admin-preview.mjs --action prepare
node scripts/admin-preview.mjs --action start
node scripts/admin-preview.mjs --action web
```

默认 Web 为 `http://127.0.0.1:5187`，API 为 `http://127.0.0.1:3081`；端口占用时可显式使用 `--web-port` 和 `--api-port`，两端参数必须一致。`--email-file` 可读取部署者明确指定的配置到内存；`--action check-mail` 只校验连接/TLS/认证，不发邮件。

旧迁移明确使用 `public` schema，不能仅通过更换 schema 隔离。脚本会创建独立测试数据库，不重置已有数据库。浏览器验收使用另外的 `mc_admin_browser_*` 临时数据库，保留用于问题复查；未执行批量清理。

## API 兼容

`POST /v1/auth/register` 现在返回 `202` 和邮箱验证/投递状态，不再立即签发业务令牌。外部客户端需要调用 `/v1/auth/verify` 完成验证；Web 已同步处理成功、待验证、邮件失败和重发。新接口与响应见既有 OpenAPI 入口中的账户管理定义。

实际账户部署要求带 `sid` 的可撤销会话。旧式没有会话 ID 的用户 JWT 需要重新登录，避免修改密码、禁用或撤销会话后仍能继续使用旧令牌。该兼容调整不修改用户资料和资源；已由账户登录接口签发的有状态会话继续按照撤销与到期策略处理。

存量账户保持原资料、密码和状态；没有验证记录的邮箱继续明确显示未验证，不会通过迁移伪造已验证状态。密码修改、更换邮箱、禁用与会话撤销均有独立流程。系统 ID、密码哈希、对象键、摘要和审计字段不能通过业务编辑表单任意修改。

明确属于当前用户项目、但缺少资源 owner 的历史文件按经核验的项目范围兼容读取，不回填或改写归属。API 签名链接会检查禁用状态；原生 S3 已签发链接仍可能在最长 900 秒的原有效期内可用，撤销会话不能使它们立即失效。

## 发布与回滚

新增迁移为 `20260906120000_admin_accounts` 和 `20260906130000_admin_lifecycle`，原迁移校验和未修改。迁移新增用户验证/状态、账户挑战、初始化标记、审计、投递状态和生命周期字段，不删除项目或资源。

正式发布需先记录当前提交/镜像、管理员与账户数量、邮箱规范化冲突、历史 owner 缺失/冲突数量，并备份数据库、对象存储及必要密钥卷，确认备份可读和恢复方式。完成具体生产操作授权后，再对目标数据库应用迁移、更新 API/Worker/Web 并完成真实入口冒烟。当前轮次只对隔离数据库执行了迁移。

若新版本出现问题，应保留新增账户/邀请/审计数据，并回退到经过兼容验证的应用镜像。旧 API 不理解待验证和禁用状态，不可直接把流量切回旧认证逻辑而放开这些账户；应先关闭账户写入口并采用兼容回滚或向前修复。不要反向删除新增表，也不要用旧数据库快照覆盖发布后的新增数据。

## 可复跑验证

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
node --test scripts/email-config.test.mjs scripts/docker/config.test.mjs
$env:DATABASE_URL = 'postgresql://test_user:synthetic-test-password@127.0.0.1:19432/admin_review?schema=public'
pnpm db:validate
pwsh -NoProfile -File scripts/verify-isolated.ps1 -Action Test -Project mc-acceptance-test-p0p1
$env:ADMIN_BROWSER_WEB_URL = 'http://127.0.0.1:5188'
node apps/api/node_modules/tsx/dist/cli.mjs scripts/fixtures/admin-browser-smoke.mjs
```

最后一个命令要求 Web 已运行；它只改写 API 请求目的端口，实际请求经过 Fastify、Prisma 和文件存储，邮箱使用内存替身。覆盖初始化、邀请 A/B、独立注册到可刷新的验证码页、确认后回工作台、独立登录及受控返回、创建项目、真实 mock 生成归档、运行中与完成后的头像/个人信息往返、首页返回工作台、按用户资源、管理员编辑/归档/恢复、禁用和退出。核对验证前无会话、注册后无自动创建、身份、节点尺寸、结果可见和生成/注销次数；测试报告明确区分合成邮件、实际 SMTP 握手和真实邮件送达。

常规单测中的设施 skip 不是成功验收的替代：独立数据库/Redis/TLS、媒体和账户数据库的实际结果分别记录在 `.data/admin-isolated-*` 和 `.data/admin-final-legacy-assets-*` 日志。首页媒体采用 [MDN CC0 素材](../apps/web/public/demo/README.md)，帧耗时、图片/视频检查和视口证据见 [首页检查点](homepage-ui-motion-todo.md)。

后置事项仍保留在 TODO：正式数据迁移与邮件投递验收、后台自动邮件重试、跨用户迁移/代跑、永久删除/批量操作、配额限制及更完整的登录设备信息。它们未作为已经实现的能力对外开放。
