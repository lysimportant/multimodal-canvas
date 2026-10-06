# 资源预览分享检查点

2026-10-06 增量：可选分享密码、解锁读取和大肥鱼头像见[分享密码检查点](asset-share-password-checkpoint.md)。下文保留最初无密码分享的验收记录；当前匿名端点还包含独立的密码解锁 POST。

更新时间：2026-10-05。任务级别：P1；基线 `main @ 5effcfe`，开始时工作区干净，上游 `origin/main`。

## 目标与边界

资源预览弹窗增加分享入口。用户点击后生成 7 天有效的只读链接，接收者无需登录即可查看被选中的资源版本。匿名分享页仅获取资源名称、类型、字节数、版本、到期时间和内容，不返回项目、生成提示词、资源元数据或账号凭据。

本次不包含多人协作、编辑权限、永久公开资源、单条链接撤销、数据库迁移、生产部署或真实供应商调用。链接持有者可以查看并保存资源；无持久分享表，单条链接不提供主动撤销。

## 兼容与回滚

新增独立分享 API 和 `/share` 页面，以不透明 AES-256-GCM 令牌绑定资源所有者及版本。分享用途参与密钥派生和认证数据，不能作为既有短期访问令牌或账户身份使用。无需更改数据结构或备份迁移；回滚本次代码即可关闭分享入口和分享接口，既有数据不变。

稳定密钥按 `ASSET_ACCESS_URL_SECRET` → `API_JWT_SECRET` → `API_AUTH_TOKEN` 顺序复用，未新增配置项，也不使用进程随机密钥兜底。轮换实际选中的密钥会使旧分享链接失效。新增 API、前端页面及网关日志规则需要一起更新；本轮没有执行部署。

## 已实现行为

- `AssetViewerDialog` 的下载按钮旁增加“分享”。仅用户点击才创建链接，优先冻结当前内容地址的版本；缺少明确版本时由 API 读取最新版本。创建中防连点，失败可重试，剪贴板失败可手动复制。
- 分享链接使用 `/share#token=…`，固定 7 天有效。本次预览可复用未过期链接；到期后只能由用户点击重新创建。切换资源、账户或关闭页面时，中止请求并忽略迟到结果。
- 分享浮层通过 Ant Design Popover 挂载到 `document.body`，不参与预览尺寸计算；Escape 先关闭浮层并把焦点返回分享按钮。
- `/share` 在工作区会话初始化之前渲染独立页面，支持图片、视频、音频和转义后的纯文字。页面不请求项目、任务、提示词或账户接口；音视频不自动播放，失效后移除内容并给出明确提示。
- `POST /v1/assets/:assetId/share` 仅允许资源所有者的用户会话；拒绝服务令牌、跨所有者和无效版本。返回 `{ token, expiresAt, version }`。
- `GET/HEAD /v1/asset-shares?token=…` 返回展示字段白名单；`GET/HEAD /v1/asset-shares/content?token=…` 返回被冻结版本的内容。匿名放行只匹配这两个精确只读端点，不建立登录主体。
- 每次读取重新确认所有者有效、资源可用和版本存在；公开请求按 IP 限速。内容支持单段 Range、HEAD、206/416，使用 `no-store`、`nosniff` 和无来源信息策略，可执行格式按受限附件返回。
- Fastify 日志移除查询串；Caddy 错误日志同时脱敏 `access_token`、`token` 和请求头，包含重复查询参数的回归覆盖。OpenAPI 已同步说明公开端点和响应。

## 基线与执行状态

- Node `v24.12.0`，pnpm `11.19.0`；根、Web、API 本地依赖已存在。
- 修改前：`AssetPreview.test.tsx`、`AssetPreview.thumbnail.test.tsx` 共 51 项通过；`assets.test.ts`、`asset-ownership.test.ts` 共 31 项通过。
- 当前实现与本轮本地验收已完成；未更改依赖、锁文件或数据库结构。
- 首次 `pnpm test` 遇到 Windows 临时目录 `EPERM`；串行 Turbo 重跑仍因包内并发出现 Web 超时。改用仓库内忽略目录 `.local-tests/asset-share-tmp` 作为进程临时目录，并显式限制 Vitest worker 后完成逐包全量重跑。未修改产品代码或断言以掩盖失败。
- 最后完成：API 收尾的 lint/typecheck/build 与分享 10 项回归、5187 浏览器 2 项复验、临时 Caddy HTTP/HTTPS 日志脱敏 2 项验收。全仓检查结果见下表。
- 交付位置：`origin/main`，中文附注 Tag `v2026.10.05-asset-share`；最终提交 ID、推送结果与远程引用核对见 Git 和交付回复。

## 本轮验证

测试前仅在进程内设置 `WEB_PORT=5173`、`VITE_API_BASE_URL=http://localhost:3000` 及上述临时目录，避免继承正式构建的同源空值或并发测试相互干扰。浏览器专项改用独立 Web 端口 5187，不占用已有服务。

| 验证                 | 命令与结果                                                                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 全仓格式、类型、构建 | `pnpm exec turbo run lint typecheck build --force --concurrency=1`：27/27 任务通过，零缓存。Vite 既有大 chunk 提示仍保留。                                              |
| Web 全量单测         | `pnpm --filter @multimodal-canvas/web exec vitest run --maxWorkers=2 --minWorkers=1`：127 文件、2332 项通过。                                                           |
| API 全量单测         | `pnpm --filter @multimodal-canvas/api exec vitest run --maxWorkers=1 --minWorkers=1`：68 文件通过，1181 项通过、92 项跳过；外部设施跳过不算集成验收。                   |
| Worker 全量单测      | `pnpm --filter @multimodal-canvas/worker exec vitest run --maxWorkers=2 --minWorkers=1`：21 文件通过，784 项通过、28 项跳过。                                           |
| 共享包               | 强制重跑的 domain 372、providers 768、execution 43、observability 21、ui 16、credential-crypto 7 项全部通过。                                                           |
| 运行产物             | `pnpm test:runtime`：8/8 通过。                                                                                                                                         |
| API 最终复核         | `pnpm --filter @multimodal-canvas/api lint`、`typecheck`、`build` 通过；`asset-shares.test.ts` 10/10 通过，覆盖权限、固定版本、空内容、篡改、过期、失效、Range 与限速。 |
| PC 浏览器            | `WEB_PORT=5187` 下运行 `pnpm --filter @multimodal-canvas/web exec playwright test -c playwright.config.ts e2e/asset-share.spec.ts --workers=1`：2/2 通过，17.1 秒。     |
| 网关日志             | `node --test scripts/docker/proxy-log.test.mjs`：临时、无业务卷的 Caddy HTTP/HTTPS 2/2 通过；语法及格式检查通过。                                                       |
| 差异检查             | `git diff --check`、检查点和新增脚本格式检查通过；最终任务新增行未发现真实凭据、调试输出或冲突标记。                                                                    |

浏览器使用合成账户、API 拦截和仓库演示媒体，不连接用户项目或真实供应商。覆盖图片分享创建与自动复制、匿名图片/视频/音频/文字及失效态；匿名元信息和媒体请求逐条断言不携带 Cookie/Authorization，且不访问私有接口。失效资源不继续获取媒体。仅预期 410 场景出现对应网络错误，其余场景无控制台或运行时错误。

已实际检查 PC 截图：1440×900 图片页、1366×768 音视频/文字/失效态及 1280×480 预览分享浮层。小高度窗口验证浮层四边位于视口内，打开前后原 Dialog 的位置与尺寸变化不超过 1px；Escape 保留原预览并恢复触发按钮焦点，再次打开仍只有一次分享 POST。截图保存在 `apps/web/test-results/asset-share-*`，本地日志保存在 `.local-tests/asset-share-*.log`，均不提交到仓库。

## 当前边界

- 分享接收者可以继续转发或保存文件；本轮不提供单条链接撤销。资源归档、删除或所有者停用期间拒绝读取；未过期时恢复可用状态可能恢复访问，不能视为永久撤销。
- 7 天链接需要稳定密钥及原资源版本持续可用；服务重启不应换用随机密钥。
- 内容读取沿用现有 Store 的整块 Buffer 接口，Range 在读取后切片；未将本次测试解释为大文件流式能力或公网吞吐验收。
- 正式使用须将 Web/API 部署到接收者可访问的地址；从 `localhost` 或 `127.0.0.1` 创建的链接只能在相应本机访问。自建网关也应脱敏分享查询参数。
- 本轮没有执行生产部署、真实 Provider 请求、数据库迁移或完整存量 E2E；供应商、生产设施和既有扩展 E2E 待办仍按原 TODO 推进。

## 验收标准

- 点击分享后可复制链接，失败保留原因和重试；剪贴板不可用时允许手动复制，不能重复创建请求。
- 未登录浏览器直接查看图片、视频、音频和文字；不触发会话请求或生成任务。
- 链接固定版本，跨所有者创建、篡改、过期、资源失效均明确拒绝；不能通过分享访问其他资源和接口。
- 既有预览缩放、下载和节点尺寸保持正确；PC 页面无遮挡和控制台错误。
- 本地 Mock、接口测试与真实生产可访问性分别记录，不将本地通过写成公网部署通过。
