# 项目 TODO

这份清单是项目的单一进度入口。以后新增需求先归入对应阶段，再标注状态、优先级和验收条件。

## 状态约定

- `[x]` 已完成并通过当前验收
- `[~]` 进行中，已有代码但仍缺生产能力或验收项
- `[ ]` 未开始
- `[!]` 阻塞，需要外部条件或明确契约
- `[>]` 暂缓，排在 MVP 之后

当前可执行条目计数（2026-08-27）：核心 MVP 功能及 6 项生产化验收均已完成，当前为 0 个 P0、0 个 P1 可执行条目。收费/累计额度、Tauri 和协作等能力继续暂缓。导出工作流与结果包已完成。新增条目时请同步更新本行。

优先级：`P0` 阻塞 MVP 或存在数据/安全风险；`P1` MVP 必需；`P2` MVP 后增强。

## 当前总览

| 阶段       | 主题                                          | 状态          | 优先级  |
| ---------- | --------------------------------------------- | ------------- | ------- |
| 0          | 工程基础                                      | `[x]`         | P1      |
| 1          | 领域协议与画布校验                            | `[x]`         | P1      |
| 2          | 资源库基础能力                                | `[x]`         | P1      |
| 3          | 项目与画布持久化                              | `[x]`         | P0      |
| 4          | 运行状态机与实时进度                          | `[x]`         | P1      |
| 5          | AI 设置与模型选择                             | `[x]`         | P1      |
| 6          | New API Provider                              | `[x]`         | P1      |
| 7          | 生产数据链路                                  | `[x]`         | P0      |
| 8          | 视频异步链路                                  | `[x]`         | P1      |
| 9          | 安全、用量与可观测性                          | `[x]` / `[>]` | P0 / P2 |
| 10         | 自动化验收与桌面端                            | `[x]` / `[>]` | P1 / P2 |
| 生产化验收 | DAG 执行、启动边界、Provider/Schema/CI 完整性 | `[x]`         | P0 / P1 |

## 已完成

### 阶段 0：工程基础

- `[x]` pnpm workspace + Turborepo monorepo
- `[x]` `apps/web`、`apps/api`、`apps/worker`、`packages/domain`、`packages/providers`、`packages/ui` 基础目录
- `[x]` Prisma schema、Docker Compose 开发依赖和环境变量示例
- `[x]` Prisma 初始迁移脚本（`prisma/migrations/0001_init`，仅生成 SQL，不连接业务数据库）
- `[x]` lint、typecheck、test、build、format check 脚本

### 阶段 1：领域协议与画布校验

- `[x]` text/image/audio/video 节点和 source/generate/transform 模式 Schema
- `[x]` 角色化端口和媒体类型兼容性校验
- `[x]` 多个上游输入、输入顺序和边协议
- `[x]` DAG 拓扑校验和环路阻止
- `[x]` 上游变化后的 stale 标记与运行快照模型

### 阶段 2：资源库基础能力

- `[x]` 资源上传、预览、搜索、筛选、标签、重命名
- `[x]` 归档、恢复、下载和从资源拖入画布创建 source 节点
- `[x]` 文字、图片、音频、视频四类资源的基础展示
- `[x]` `PrismaAssetStore`、S3/MinIO/本地 BlobStore、SHA-256 和资产版本链路

### 阶段 3：项目与画布

- `[x]` 项目创建、项目读取和画布保存
- `[x]` revision 乐观锁，旧版本提交返回冲突
- `[x]` 配置 `DATABASE_URL` 时使用 Prisma/PostgreSQL 保存项目和画布
- `[x]` Prisma 项目 Store 与资产 Store 已统一，画布保存校验项目/全局资源归属

### 阶段 4：运行状态机与实时进度

- `[x]` 运行快照、目标节点校验和模型解析优先级
- `[x]` Mock Worker：排队、运行、成功、失败、取消、重试
- `[x]` SSE `/v1/projects/:projectId/events`
- `[x]` Web 端通过 `EventSource` 接收运行更新
- `[x]` Provider Job 生命周期、幂等键、结果归档扩展点、取消与失败重试

### 阶段 5：AI 设置与模型选择

- `[x]` Base URL、API Key 密码输入和服务端加密存储
- `[x]` 连接测试、模型刷新和按媒体类型选择默认模型；兼容常见网关模型响应别名，合并重复模型能力/限制，支持数据库能力覆盖，并在刷新失败时保留旧目录
- `[x]` 节点 `modelAlias` 覆盖项目默认模型
- `[x]` 已提交任务固化模型和凭据版本，不受后续设置修改影响
- `[x]` 配置 `DATABASE_URL` 时由 `PrismaAiSettingsStore` 持久化凭据、默认模型和模型目录

### 阶段 6：New API Provider

- `[x]` 文字 `/chat/completions`
- `[x]` 图片 `/images/generations`
- `[x]` 音频 `/audio/speech`
- `[x]` 解析真实文本、图片和音频响应（文本片段、图片 URL/base64、音频 JSON/二进制）并转换为统一 Worker 输出
- `[x]` 节点推理强度在 Provider 边界映射为文字模型的 `reasoning_effort`；图片、音频和视频请求剔除内部控制字段
- `[x]` Worker 生产归档器将生成结果写入 Prisma 资产与首个版本，支持 S3/MinIO 或文件 BlobStore，并保留模型、参数和运行来源元数据
- `[x]` 已用 `gpt-image-2` 通过真实图片渠道验收：`POST /v1/images/generations` 首次请求返回 `200`，响应含 `data[0].b64_json`；凭据未写入仓库或日志
- `[x]` Worker 按任务 `provider` 选择 Mock 或 New API
- `[x]` 视频异步 Provider、任务状态轮询、受保护内容下载和结果归档已接入；真实网关契约已通过创建/轮询/MP4 下载验证

### 当前验证

- `[x]` `pnpm format:check`
- `[x]` `pnpm lint`
- `[x]` `pnpm typecheck`
- `[x]` `pnpm test`（API 184 通过、4 跳过；domain 16、providers 77、worker 84、Web 124、UI 3、observability 14；无显式隔离 `TEST_*` 配置时外部服务集成测试安全跳过）
- `[x]` `pnpm build`
- `[x]` `pnpm test:e2e`（Chromium 14 项通过，含四类节点运行、模型切换、三参考连线、主题/侧栏/缩放、设置模态与桌面/320px/390px 滚动锁、Clipboard 权限拒绝和非法文本回退）
- `[x]` `DATABASE_URL=... pnpm db:validate`
- `[x]` `pnpm install --frozen-lockfile`
- `[x]` 隔离 PostgreSQL、Redis namespace 与 MinIO bucket 集成测试 12 项通过，覆盖真实 `0001-0007 -> 0008` 升级、schema diff、事务回滚、生命周期、Redis 和 MinIO
- `[x]` 临时 New API 凭据真实文本与图片请求成功（图片使用 `gpt-image-2`，返回 base64 图片）；协议解析与模拟归档测试通过
- `[x]` 连接测试与模型目录刷新失败自动重试，最多 10 次；生成请求不在 Provider 内自动重试以避免重复扣费（`apps/api/src/settings.test.ts`）
- `[x]` 真实视频链路验证：已完成一次 New API 视频任务的创建、`queued -> in_progress -> done` 轮询和 MP4 下载；Provider/Worker/API 恢复与去重测试通过
- `[x]` 生产 BullMQ Worker 按运行快照的 `credentialId/version` 解密读取历史凭据；凭据热切换和撤销不影响已提交任务，缺失快照不会回退到当前环境 Key

## 已验收生产边界

### P0：统一生产持久化边界

- `[x]` 设计并实现 Prisma 资产 Store，与项目/画布 Store 使用同一数据库
- `[x]` 明确资源 ID、项目归属和外键校验，禁止画布引用不存在或跨项目资源
- `[x]` 保留未配置数据库时的内存 Store，仅用于本地开发和单元测试
- `[x]` 为 Prisma Store 增加独立临时数据库集成测试；仅使用显式 `TEST_DATABASE_URL`，随机 schema 隔离并验证重启恢复

完成条件：重启 API 后项目、画布、资源及资源引用仍可恢复；跨项目资源引用被拒绝；测试不会触碰真实业务数据库。

## 生产化验收

### 生产化验收（已完成）

以下条目已完成真实部署、恢复和隔离能力验收。

- `[x]` [P0] Worker 按不可变运行快照执行完整 DAG
  - 依赖：`RunSnapshot`、Worker、`provider_jobs`、结果归档与资产版本。
  - 验收：运行到目标节点时先计算其全部上游闭包并按拓扑顺序执行；source 节点从快照解析输入，generate/transform 节点的成功输出固化为下游参考；扇入、分支、失败、取消、进程重启和重试均不读取运行期间变化的画布，也不重复创建平台任务或重复扣费；补齐对应 Worker 测试。

- `[x]` [P0] API 与 Worker 在生产环境缺配置时 fail-closed
  - 依赖：API/Worker 启动配置、Prisma/PostgreSQL、Redis、S3 和 New API Provider。
  - 验收：`NODE_ENV=production` 下启动必须要求 PostgreSQL、Redis、S3 bucket、New API Base URL 与 `WORKER_PROVIDER=newapi` 的必要配置；缺失时明确拒绝启动，不能隐式回退 Mock、内存或文件存储；开发和测试环境仍可显式使用回退实现；不要求数据库预先存在 AI 凭据。

- `[x]` [P1] Provider 完整映射统一端口角色并对不支持输入显式失败
  - 依赖：领域端口协议、模型能力、`NewApiProvider`、`NewApiVideoProvider`。
  - 验收：`prompt`、`negativePrompt`、`content`、`style`、`character`、`firstFrame`、`lastFrame`、`audioTrack`、`transcript`、`mask` 均保留角色和顺序，并映射为平台字段或返回可诊断的“不支持该输入角色”错误；不得把角色静默降级为普通文本或丢弃；供应商专用字段只存在于 Provider 边界；补齐角色映射测试。

- `[x]` [P1] 补齐 Prisma 业务表生命周期时间戳并提供兼容迁移
  - 依赖：Prisma schema、迁移、集成测试。
  - 验收：所有业务表具备 `createdAt`、`updatedAt`；至少补齐 `AuthSession`、`CanvasEdge`、`AssetVersion`、`UploadSession`、`RunInput`、`UsageLedger`、`WebhookEvent`；迁移对已有生产数据兼容，不通过重置数据库完成；创建和更新行为有测试覆盖。

- `[x]` [P1] CI 运行隔离集成链路，并初始化本地 MinIO bucket
  - 依赖：GitHub Actions 服务容器、API 集成测试、Docker Compose、MinIO。
  - 验收：CI 使用独立 PostgreSQL、Redis namespace 和 MinIO bucket 执行 `test:integration`，不调用真实 New API；测试数据与真实数据库、WAL/SHM、上传目录完全隔离；开发 Compose 提供一次性 bucket 初始化服务，新环境启动后可直接上传；补齐初始化与失败场景验证。

- `[x]` [P1] 落实固定 Web 技术栈并建立可复用 `packages/ui`
  - 依赖：React 工作台状态、API 请求层、认证/设置/项目表单、Web/Tauri 共用组件边界。
  - 验收：Zustand 实际承载画布或工作台客户端状态及持久化；TanStack Query 实际承载项目、资源、模型或运行等服务端状态并具备缓存失效/刷新；React Hook Form + Zod 实际处理认证、设置或项目表单；Tailwind CSS 与 shadcn/ui 约定用于 `packages/ui` 的可复用基础组件，Web 至少复用一组生产界面组件；不得只安装依赖或保留占位导出；补齐状态、请求、表单和组件测试，并通过 Web 类型检查、lint、构建及桌面/移动验收。

### 阶段 7：生产数据链路（P0）

- `[x]` S3/MinIO 对象存储适配器和隔离的开发 bucket 配置
- `[x]` multipart 与直传初始化/上传完成协议已完成，并校验大小、MIME、SHA-256；配置 PostgreSQL + S3/MinIO 时使用预签名 PUT 和持久化上传会话，文件系统/内存实现保留作开发回退
- `[x]` SHA-256、可选 ffprobe 元数据和可选 ffmpeg 派生媒体已接入；启用 `FFMPEG_ENABLED` 后生成图片缩略图、视频 poster、音频波形并通过 BlobStore 提供受控 URL
- `[x]` `asset_versions` 创建、版本内容读取和结果归档扩展点
- `[x]` 归档与恢复的数据库持久化；节点删除不删除资源
- `[x]` 资源访问权限已具备项目隔离，派生和原始内容均通过 API 路由提供；生产环境下载 URL 要求用户 Bearer 会话，并支持 S3/MinIO 预签名 GET 或内存/文件存储 HMAC 短时 URL（原始内容、版本和派生内容均覆盖）
- `[x]` New API 文本/图片/音频生成结果已接入 Worker 资产归档；归档 URL 下载有 HTTPS、私网地址、超时和大小限制；Provider 错误按状态、错误码、请求 ID 和可重试性结构化诊断，生成请求不在 Provider 内自动重试

### 阶段 8：视频异步链路（P1）

- `[x]` 已确认当前 New API 的视频契约：`POST /videos/generations` 创建、`GET /videos/:requestId` 轮询、`GET /videos/:requestId/content` 鉴权下载；成功态为 `done` 且结果位于 `video.url`，当前平台未公开视频 Webhook/签名契约，因此使用轮询
- `[x]` `NewApiVideoProvider` 单次创建、平台任务 ID 即时回调、有限退避轮询和安全状态摘要已完成；轮询超时/进程重启可恢复已有任务
- `[x]` Worker 已在 BullMQ job 与 `provider_jobs` 中持久化中间状态，并支持从前序 run 恢复平台任务
- `[x]` Provider 已支持外部结果 URL 和受保护 content 端点鉴权下载；Worker 写入 S3/MinIO、可选 ffprobe 元数据并创建资产版本
- `[x]` 重试前继承已有平台任务 ID，避免重复创建平台任务和重复扣费

### 阶段 9：安全、用量与可观测性（P0）

- `[x]` Bearer API token、HS256 JWT（生产要求 `exp` 和用户存储校验）、Webhook HMAC、项目资源隔离和生产缺失令牌保护；邮箱注册/登录、scrypt 密码哈希、可撤销会话、`USER`/`ADMIN` 角色、当前用户查询和登出已完成，管理员会话可管理平台 AI 设置
- `[x]` 凭据版本化、删除凭据和不可逆指纹返回
- `[x]` 凭据删除写入撤销标记版本并保留历史加密版本，保证排队/运行快照可恢复；Worker 只接受精确凭据引用
- `[x]` `provider_jobs`、`usage_ledger` 已接入 Worker 可选持久化边界，并完成 UUID/金额校验；New API 已解析供应商显式金额与 token/media usage（无明确货币时仅保留 metadata，不估价）；账本幂等键可防止供应商重试重复记账，运行并发额度、模型价格估算和单次成本上限已接入
- `[>]` 收费、供应商累计额度和完整 usage 对账暂缓，待后续产品策略与供应商账单契约确定
- `[x]` 幂等键、防重复提交、失败诊断和可恢复重试
- `[x]` 项目级运行历史查询（`GET /v1/projects/:projectId/runs`）与项目授权
- `[x]` Webhook HMAC 验签、事件去重和 `webhook_events` 持久化审计
- `[x]` Pino 结构化日志已接入 API/Worker（请求/运行 ID 关联、敏感字段和错误文本脱敏、`LOG_LEVEL` 开关）；共享 observability 边界已提供可选 OTLP HTTP traces、Sentry envelope 和脱敏/失败隔离，默认仍不向外发送
- `[x]` 已提供静态 OpenAPI 文档并覆盖所有路由，补齐主要请求/响应 Schema、错误响应和 SSE 内容类型

### 阶段 10：前端完整体验与验收（P1）

- `[x]` 画布平移、缩放、框选、多选、复制/粘贴、删除、撤销/重做、自动保存已实现；连线端口/环路/重复校验已抽出并完成纯逻辑测试，画布 RTL 交互测试、桌面/移动视觉验收均已补齐；快捷键已避开表单控件，来源节点不再暴露输入端口
- `[x]` 节点属性抽屉、运行到指定节点、进度/错误/重试和真实归档结果版本列表已实现；版本读取失败时保留当前结果并显示诊断提示
- `[x]` 设置页连接状态、模型能力过滤、服务端不可用模型校验和 Base URL/API Key 字段级表单错误提示已实现，并有纯逻辑测试；默认模型与凭据删除失败会显示明确反馈
- `[x]` Web Vitest 已覆盖画布文档转换、环路检测、连线校验、上传协议、剪贴板、快捷键、设置表单、结果版本加载、工作台、命令面板、失败诊断和画布编辑器交互（94 tests）
- `[x]` Playwright/浏览器 smoke 已覆盖启动、节点创建、设置连接、上传、拖入、多参考连线、节点模型覆盖、结果展示、Mock 默认模型切换、主题/侧栏/缩放和 Clipboard 权限场景（Chromium 13 tests）
- `[x]` 已完成桌面和移动尺寸人工视觉验收；剪贴板支持版本化系统 Clipboard 与内存回退，解析校验和浏览器权限自动化均已通过
- `[x]` 本轮交互增强：节点主体拖线自动吸附兼容输入端口，并继续执行端口/环路/重复校验
- `[x]` 本轮交互增强：生成/转换节点工具胶囊居中，使用不同图标区分两种操作
- `[x]` 本轮交互增强：节点四角 `NodeResizer` 拉伸，宽高随画布保存并恢复
- `[x]` 本轮交互增强：节点启用/停用开关；停用节点不进入运行快照参考输入
- `[x]` 本轮交互增强：设置页打开时从 `/v1/models` 加载模型，并按媒体类型过滤默认模型下拉框
- `[x]` 本轮交互增强：资源侧栏支持折叠，状态持久化到浏览器
- `[x]` 本轮交互增强：画布背景选择器移动到 Header 右侧
- `[x]` 本轮交互增强：护眼、明亮、深色、暖白、高对比五套主题及过渡效果
- `[x]` 生产 Web 认证接入：登录、注册、退出、会话持久化、Bearer 请求、认证 SSE、上传鉴权和受保护媒体短期 access URL
- `[x]` New API usage 解析边界：显式金额+货币才写入费用账本，token/media usage 保留到 provider job metadata，不从用量猜测费用
- `[x]` 最小 stale 传播：节点内容/模型/启用状态变化会沿出边标记下游待更新，运行成功清除目标 stale 并保留旧结果

### 收费与额度（暂缓）

- `[>]` 收费、套餐、累计额度、供应商 usage 对账和账单页面暂缓；当前只保留防止误提交的单次成本上限和并发保护，待用户认证与真实供应商 usage 契约确定后再实现。

### 阶段 11：MVP 后工作（P2）

- `[>]` Tauri 桌面壳复用 Web 前端
- `[x]` 导出工作流 JSON 与结果 ZIP（含 `workflow.json`、`manifest.json`、结果版本文件；不导出凭据和签名 URL）
- `[>]` 多人协作、插件市场、代码节点、完整视频剪辑器、复杂手机画布

### 后续 UX 与可靠性优化

- `[x]` [P1] 工作台项目卡片支持重命名、归档、最近打开和按更新时间排序
  - 依赖：工作台项目集合、项目归档 API
  - 验收：项目可在工作台完成重命名/归档/恢复；默认按最近编辑排序；当前项目有明确状态且不会误切换。验证：`apps/web/src/ProjectHub.test.tsx`；Web 102 tests passed。
- `[x]` [P1] 工作台与弹窗完善键盘导航和焦点管理
  - 依赖：`ProjectHub`、主题菜单、项目创建/设置弹窗
  - 验收：Tab 顺序稳定；Esc 关闭；方向键/Home/End 可操作列表；关闭后焦点回到触发按钮；屏幕阅读器能读出状态。验证：`ProjectHub.test.tsx` 3 tests passed。
- `[x]` [P1] 运行反馈统一为 SSE 主导、退避轮询兜底
  - 依赖：项目事件流、运行状态机
  - 验收：正常运行不再每 250ms 全量请求；SSE 断线自动退避重连；重连后状态不丢失，失败原因可见。验证：`apps/web/src/auth-client.test.ts`；Web 102 tests passed。
- `[x]` [P1] 失败运行重试结果与错误诊断统一呈现
  - 依赖：运行重试 API、节点结果面板
  - 验收：重试成功显示成功提示；失败显示最终错误、可重试性和请求 ID；不会重复创建已有平台任务。验证：`apps/web/src/FailureDiagnostics.test.tsx`、Web 102 tests passed。
- `[x]` [P1] 结果媒体 URL 按来源安全加载
  - 依赖：资产访问 API、预签名 URL
  - 验收：仅本项目受保护资源携带 Bearer；外部 CDN/预签名/data/blob URL 不附加错误鉴权头；跨域加载与下载均可用。验证：`apps/web/src/App.tsx` 结果读取与 Web 测试通过。
- `[x]` [P0] 认证、SSE 和 Provider 统一限流与响应体上限
  - 依赖：API 部署拓扑、Redis 限流、Provider 错误边界
  - 验收：注册/登录具备暴力破解保护；多实例共享限流；SSE/Provider 响应大小受限；超限返回可诊断错误。验证：`apps/api/src/rate-limit.test.ts`；API 158 tests passed, 1 skipped。
- `[x]` [P2] 画布编辑器拆分为节点、工具栏、运行面板和状态模块
  - 依赖：现有 `App.tsx` 行为测试
  - 验收：节点、资源/设置面板、节点工具栏、画布容器、运行面板及运行结果状态已拆到 `apps/web/src/workspace`；`App.tsx` 不再保留重复实现，画布协议未改变。验证：`apps/web/src/workspace/workspace-modules.test.tsx`；Web 102 tests passed；Web typecheck、lint、build 通过，并完成桌面/390px 浏览器交互检查。

### 本轮新增 UX 推荐

- `[x]` [P1] 修正透明 Header、画布背景菜单与节点就地生成交互
  - 依赖：`WorkflowCanvas`、节点属性面板、主题/背景控制和 `NodeResizer`
  - 验收：Header 作为透明工具层覆盖画布且右侧操作不拥挤；背景菜单可打开并切换；点击生成/转换节点后在节点下方显示提示词、模型、推理强度和生成按钮；右侧详情不再重复这些控件；节点拉伸时内部预览同步占满剩余高度；桌面与 390px/320px 视口无溢出、遮挡或控制台错误。
  - 验证：`pnpm --filter @multimodal-canvas/web test`（109 tests）、`pnpm --filter @multimodal-canvas/web test:e2e`（13 tests）、`pnpm --filter @multimodal-canvas/web typecheck`、`pnpm --filter @multimodal-canvas/web lint`、`pnpm --filter @multimodal-canvas/web build`；完成桌面/390px 浏览器检查。

- `[x]` [P1] 画布空状态提供可执行的快速开始入口
  - 依赖：现有资源栏、节点创建和上传流程
  - 验收：空画布显示上传资源、新建文字节点和打开工作台三个入口；点击后直接进入对应流程；窄屏不溢出。验证：Web 测试与移动视口检查通过。
- `[x]` [P1] 命令面板与快捷键发现
  - 依赖：现有画布快捷键、项目切换、运行和导出动作
  - 验收：`Ctrl/Cmd+K` 打开可搜索命令面板；命令可执行项目切换、运行、保存、导出和主题切换；表单输入时不抢占快捷键；Esc 关闭并恢复焦点；长列表键盘导航会保持活动项可见。验证：`apps/web/src/CommandPalette.test.tsx`、Web 102 tests passed。
- `[x]` [P2] 工作台项目收藏与筛选
  - 依赖：工作台项目集合和项目归档字段
  - 验收：项目可收藏/取消收藏，支持全部/收藏筛选；状态持久化；当前项目标识和归档规则不变。验证：`apps/web/src/ProjectHub.test.tsx`；Web 102 tests passed。
- `[x]` [P1] 移动端 Header、节点工具栏与弹窗滚动优化
  - 依赖：透明 Header、节点工具栏、工作台与命令面板
  - 验收：320px/390px 视口无水平溢出；Header 不被操作区过度撑高；节点工具栏单行横向滚动且不遮挡画布；弹窗打开时背景滚动锁定。验证：`apps/web/src/responsive-ux.test.ts`；Web 102 tests passed，并完成人工浏览器检查。

## 后续需求登记规则

每次新增需求都追加一行或一个小节，至少包含：

```text
- `[ ]` [P1] 需求描述
  - 依赖：阶段/接口/外部契约
  - 验收：可执行的完成条件
```

处理顺序：先更新本文件状态，再修改代码；完成后运行与影响范围匹配的测试，并在条目中补充验证命令或结果。一次只把一个阶段标记为“进行中”，避免多个未收敛方向同时推进。

## 本轮建议顺序

1. 先完成 Worker 的完整 DAG 执行与生产环境 fail-closed 启动保护。
2. 补齐 Provider 端口角色映射和 Prisma 生命周期时间戳迁移。
3. 接入隔离 CI 集成链路与 MinIO bucket 初始化，再执行端到端恢复、重试和隔离验证。
4. 在现有 Web 行为测试保护下落实固定前端栈和共享 `packages/ui`，避免继续扩大 `App.tsx` 本地状态与手写组件债务。
5. 再评估 Tauri、计费和协作等 MVP 后能力；导出能力已完成。
