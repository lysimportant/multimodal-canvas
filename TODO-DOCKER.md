# Windows / Linux 完整 Docker Compose 运行

更新时间：2026-09-06。

## 目标与边界

- P0：Windows / Linux 共用 Compose，以正式构建和 `NODE_ENV=production` 运行 Web、API、Worker、PostgreSQL、Redis/BullMQ、MinIO 和媒体工具。
- 默认仅本机回环访问；不连接生产设施，不自动迁移现有 `.data`、开发数据库或凭据，不调用收费 Provider。
- 使用独立 Compose 项目 `multimodal-canvas-app` 和持久化卷；回滚时停止该项目并保留全部卷，不执行删除或覆盖。
- 对公网域名、真实供应商回调及未确认的模型契约不做完成承诺，继续以 `TODO-SERVER.md` 为准。

## 检查点

- [x] 基线：`main @ a3eaa4d`，起始工作区干净；Node 24.12.0、pnpm 11.19.0、Docker 29.7.2、Compose 5.4.0。
- [x] `pnpm test` 基线退出 0，13 个 Turbo 任务命中缓存；设施用例存在原有 skip，不作为本次 Docker 验收通过证据。日志 `.data/docker-baseline-test.log`。
- [x] 构建可直接用 Node 执行的 API/Worker 以及静态 Web；打包与跨目录运行回归、实际镜像构建已通过。
- [x] 完整 Compose、持久化密钥、TLS 内部依赖、14 个迁移和六项业务服务健康检查。
- [x] Windows 一键入口、管理员引导与使用文档。
- [x] Linux 启动入口、可选 Caddy HTTPS 域名入口与服务器备份/恢复说明。
- [x] Docker 实际构建、登录/项目/媒体/队列冒烟和重启后持久化验证。
- [x] 补齐浏览器实际 `/access-url` 预览链路的同源代理及回归，修复复核发现的内部 MinIO URL；最终镜像复验通过。
- [x] Linux 入口的受限代理信任链与按真实客户端地址限流，私有对端及单跳校验 20 项通过。
- [x] 用户新增本地 HTTPS 端口要求：`local-https` profile 保留 HTTP 8080，域名证书可后续反代；Windows 实际启动及 TLS 验收通过。
- [x] 安全复核收尾：统一 Caddy HTTP/HTTPS 原生过滤错误日志的媒体签名，设施密钥拆分为最小可读视图；既有密钥哈希不变。
- [x] lint、typecheck、test、build 和部署配置回归。
- [x] 最终 staged diff、Git 状态和敏感信息扫描；只包含本次 42 个文件，无用户原有改动或真实凭据进入提交。
- [x] 默认用户栈 `multimodal-canvas-app` 七个长驻服务 healthy；初始化、迁移和 bucket 服务成功退出。
- 交付记录：中文提交、annotated Tag、推送和远程核验以 Git 实际记录及最终交接为准。

2026-09-06 检查点：13 项运行时打包与 Compose 回归通过；Linux bash 语法检查通过。基础镜像已构建，隔离 `mc-acceptance-test-docker` 的 PostgreSQL、TLS Redis 和 TLS MinIO 健康，bucket 初始化成功，重复初始化保留原密钥。HTTP 代理下载故障已通过镜像内官方 HTTPS 软件源恢复，未修改主机代理。主机 lint/typecheck 已通过，尚待最终变更后的复验。

第二阶段：正式 API/Worker 产物已在隔离栈启动，六项服务均 healthy。补齐 pnpm deploy 后的 Prisma 生成客户端，避免只携带占位文件。默认同源入口关闭跨域 CORS，服务器仅接受显式 HTTPS 来源，不放松启动校验。Caddy 生产配置已校验，并通过独立本地 CA 的 HTTPS → Nginx → API 请求返回 200 与 HSTS；未修改宿主机信任库，未尝试为示例域名申请公网证书。

第三阶段：`node scripts/docker/smoke.mjs before` 和六项服务实际 restart 后的 `after` 均通过。合成文本/图片各生成一次，供应商 POST 精确 2 次、创建精确 2 次；文本没有虚构费用，图片合成 usage 仅入账 1 条。上传内容、缩略图、画布、导出 ZIP、Run/ProviderJob/UsageLedger 在重启前后相同；密钥与 CA 的 SHA-256 也保持不变。证据 `.data/docker-smoke-report.json`，无真实供应商请求。

第四阶段：API 回归 563 passed / 49 skipped（原有外部设施用例），6 项 Compose 配置回归通过。Fastify 5.12.1 对数字跳数 fail closed，已改为同时验证私有网络对端与最近一跳的回调，不降级为无条件信任。下载 proxy 使用原有短期签名与授权边界，日志不含访问令牌。

第五阶段：最终应用镜像构建完成，`after` 已覆盖同源签名预览并通过，HTTP/HTTPS 上真实客户端地址识别及伪造 XFF 拒绝通过；浏览器生产认证入口、注册切换、错误提示、控制台验证通过。完整 lint/typecheck/test/build 均通过。隔离测试栈已停止但保留卷。复核新增的两项安全改进正在收尾，网关统一为 Caddy 后会重新验收；错误上游下的 HTTP/HTTPS 签名脱敏 2 项测试已通过。

最终验收：13 项 Compose/密钥隔离回归、2 项 HTTP/HTTPS 上游故障日志脱敏、7 项冒烟脚本自检通过；运行时打包 8 项纳入 `pnpm test`。旧隔离卷在权限收紧后 `after` 再次通过，12 个密钥和证书文件的聚合 SHA-256 与改动前一致。Linux 容器内实际权限为应用 1000:1000、Redis 999:1000，目录 0700、文件 0400；PostgreSQL/Redis/MinIO 均不能访问应用 runtime.json。

Windows PowerShell 5.1 在仓库外执行 `scripts/docker.ps1 -Action Https -NoBrowser` 成功；默认栈提供 `http://localhost:8080` 与 `https://localhost:8443`，认证页面和控制台已验收。本地 CA 只导出公开证书供测试进程信任，未修改系统信任库。`SNI=localhost`、外部域名 Host 的 HTTPS `/health` 也返回经过断言的 API 响应。

最终命令：`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build` 全部退出 0（`.data/docker-release-*.log`）；API 563 passed / 49 skipped，Web 352 passed。保留 Vite 现有单块超过 500 kB 的构建警告，未为部署任务扩展性能重构。

运行状态：仅本次 `mc-acceptance-test-docker` 与其两个 helper 已停止，全部卷和原报告保留；用户默认栈持续运行，未改动开发栈或其他验收项目。首次需要用户注册自己的账户、明确管理员引导并配置供应商。真实 Linux 服务器、ARM 架构、公网域名证书、真实收费模型与公网 Webhook 未在本次本机验收中验证；这些外部事项不标记完成。
