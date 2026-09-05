# 未完成事项合并清单

更新时间：2026-09-05

本文件合并原 `TODO-NEXT.md`、`TODO-RESOURCE-MENTIONS.md` 和
`FIX-RESOURCE-MENTIONS.md` 中仍未完成、部分完成、外部依赖或明确暂缓的事项。
旧三份文档已删除；后续只维护本文件，避免同一事项在多个清单中重复或状态不一致。

## 状态与范围

**总体状态：P0 的 3 项、P1 的 6 项均尚未整体完成。子项测试通过、工作区已有代码或新增提交，都不能替代整项验收。**

- `[~]` 已有实现或部分证据，仍需外部环境、真实 Provider 或生产验收。
- `[!]` 依赖外部契约、凭据、权限或部署环境，当前无法仅靠本地代码完成。
- `[>]` 明确暂缓，排在当前 MVP 和生产基础验收之后。
- 本清单只保留未完成事项；已经完成的资源提及 P0/P1 闭环不再重复列为待办。

### 当前费用边界

- 本项目当前不向用户收费、不做本地额度扣减、不做账单结算；请求费用由上游 API/服务商计算和结算。
- 项目只记录供应商返回的 `usage`、状态、请求 ID 和可选费用字段。价格未知、费用字段缺失或没有本地收费策略，都不阻塞功能实现。
- 步数、Token、输入大小、并发、超时、搜索次数等限制只用于运行资源保护，不是本地收费授权条件。

## 已完成基线（不再列为未完成）

以下事项已有当前工作区代码、测试和提交证据，因此不从旧 `FIX` 清单中的历史 `[ ]` 继续复制：

- 资源提及编辑器、`@` 搜索、确认/取消、卡片、重复引用、撤销/重做和 PC Web E2E。
- `PromptDocument`、资源 ID/版本冻结、权限/MIME/大小校验、导入导出和 Mock 闭环。
- New API Chat Completions 的 `text`、`image_url`、`input_audio`、`video_url` 内容块映射；提及顺序和重复引用保持不变。
- 共享凭据密钥环已落地：`mc:v2:<key-id>` 密文、历史 key-id/旧 AES-GCM fallback、自动重加密和无法持久化轮换时 fail-closed；API 文件存储、Prisma 存储和 Worker 共用同一实现。
- `AiCredential.encryptionKeyId` 及迁移 `0014_ai_credential_encryption_key_id` 已加入；新旧密钥恢复、重加密和敏感信息不落日志均有测试证据。
- API/Worker 生产启动校验已覆盖 Redis/S3 TLS、CORS、端口、媒体工具和凭据密钥轮换配置；配置错误会在接受请求前显式失败。
- 本地价格/额度阻断已移除；目录价格只作为可选估算元数据，供应商费用只按返回值记录。
- 提交、类型检查、构建、格式检查、单元测试和 Mock E2E 的当前证据见“验证基线”章节。

## P0：生产基础设施与恢复

### `[~]` P0-REAL-INFRA-01 生产依赖与跨实例恢复

当前已有隔离 PostgreSQL、Redis/BullMQ、MinIO、迁移和本地队列接管证据；仍未完成：

- 生产数据库连接、数据兼容窗口和迁移升级演练。
- 生产 S3 上传/下载、对象存储权限和真实前缀隔离。
- 生产 Redis 队列接管、跨实例读写、重启恢复和真实平台任务恢复。
- 资源提及冻结版本在两个以上独立 API/Worker 进程之间的恢复验证。

验收要求：使用明确隔离的部署环境完成迁移、重启、跨实例读写、队列接管和归档，不能连接或清理真实生产数据。

### `[~]` P0-PROD-STARTUP-02 生产启动与安全边界

本地缺配置 fail-closed、认证、限流、媒体工具配置、凭据文件恢复和密钥轮换已有测试；凭据加密 key-id、历史密钥 fallback、旧 AES-GCM 迁移和轮换无法持久化时 fail-closed 已完成，不再作为阻塞项。仍未完成：

- 真实生产模式启动、TLS/反向代理和入口安全配置演练。
- 跨实例全局限流、生产环境历史凭据恢复和密钥轮换后的跨实例快照演练。
- 部署环境的告警、外部投递失败隔离和生产配置回滚演练。

本轮限流修复已完成本地验收：生产 Redis 故障不得退回进程内额度，登录、注册、普通 API 和 SSE 在受限入口返回 `503/rate_limit_unavailable` 和 `Retry-After`；开发环境保留有界内存回退。真实 Redis 独立进程共享窗口、进程重建和前缀隔离均已验证；生产部署演练仍未完成，证据见下方检查点。

已知风险：本地文件凭据模式只支持单机单 API 进程；Redis 不可用时生产受限接口牺牲可用性以保持全局限流边界。真实 TLS/反向代理和生产部署验收仍待完成。

### `[~]` P0-MEDIA-OPS-03 真实媒体处理与可观测性

FFmpeg/ffprobe 的本地真实二进制处理和注入式测试已有证据；仍未完成：

- 生产对象存储中的缩略图、poster、waveform 和元数据归档。
- OTLP/Sentry 等外部追踪、告警投递和脱敏失败演练。
- GitHub Runner 或等效隔离 CI 的完整集成执行。

外部追踪或告警投递失败不得改变主运行结果。

## P1：真实 Provider、媒体覆盖与多 Key

### `[!]` P1-VIDEO-CONTRACT-04 New API 视频完整契约

工作区中的普通请求、视频轮询、受保护下载取消及 `platformJobId` 保留改动仍待独立审核提交；现有单元测试不能证明真实 Provider 已验收。

已有通用 Base URL 下的创建、查询、受保护 content 下载、本地取消/重试、Webhook/HMAC 框架和状态归一化；仍依赖供应商确认：

- 真实取消接口、原始请求体/编码签名格式和时间戳重放窗口。
- 完整创建、查询、失败、取消、下载、`usage` 和错误字段契约。
- 真实失败重试、生产任务恢复、供应商任务幂等和隔离凭据 E2E。

当前 Webhook 对解析后的 JSON 计算 HMAC，不能替代供应商正式原始 body 签名规则；缺少平台任务 ID 的事件必须继续保持可诊断失败。

### `[~]` P1-MEDIA-COVERAGE-05 图片、音频与参考输入

图片/音频请求参数、响应解析、受控下载和 Worker 归档边界已有本地测试；仍未完成：

- 完整图片可选参数和图片 URL 可访问性验证。
- 图片 Worker 归档、真实音频请求/响应/归档。
- 多 `reference_images`、跨媒体参考输入和供应商专用字段映射。

不支持的参考角色必须在 Provider 请求前给出明确诊断，不能静默降级为文字或只发送第一项资源。

### `[~]` P1-MULTIKEY-ROTATION-06 多 Key 轮换与历史恢复

同一 DAG 中多凭据冻结、单进程文件存储重启、重复幂等、当前/历史 key-id 解密、旧 AES-GCM 迁移和轮换持久化失败保护已有测试；仍未完成：

- 真实密钥轮换、撤销后的排队任务策略和凭据版本恢复。
- 多进程/多实例恢复、生产队列恢复和跨实例历史快照读取。
- 供应商侧多 Key 请求和 `usage` 隔离行为的真实验证。

历史运行只能使用快照冻结的 `credentialId/version`；日志、导出和诊断不得包含原始 Key。

2026-09-05 补充：文件轮换未写回、Prisma 轮换错误更新活动排序、并发旧写覆盖新密文已修复。独立 API/Worker 子进程验证了历史恢复、撤销墓碑和移除旧密钥；真实数据库 CAS 竞争验证通过。这些是隔离持久化证据，不等于供应商多 Key、真实队列任务或生产部署验收；不支持不同 current key-id 实例同时进行自动重加密，受控轮换和回滚边界见 `docs/credential-rotation.md`。

### `[~]` P1-PROVIDER-ROLES-07 统一端口角色的真实映射

本地已覆盖 `prompt`、`content`、`transcript`、主输入、`firstFrame` 等角色以及重复/顺序校验；仍未完成：

- 供应商对 `negativePrompt`、`lastFrame`、`audioTrack`、`style`、`character`、`mask` 的正式字段契约。
- 多参考图、角色绑定、混合媒体和生成专用端点的互操作。
- 未确认语义角色的真实 Provider 映射和隔离实测。

没有正式字段契约的角色必须显式不支持，不能静默丢弃或伪装成已生效。

### `[!]` P1-REAL-E2E-08 隔离凭据、上游 usage 与真实请求证据

- 由平台提供隔离项目凭据，并通过部署密钥注入；不得写入源码、测试夹具、日志或导出文件。
- 完成最小真实请求，关联供应商状态、`usage`、请求 ID、内部运行 ID 和归档结果。
- 供应商未返回的价格或费用字段保持未知，不得臆造，也不能作为本项目收费或功能阻断条件。
- 真实请求失败、超时或响应不明确时，必须按幂等和人工核对策略处理，避免重复创建上游任务。

### `[!]` P1-PRODUCTION-09 生产外部验收

在获得明确授权并与真实生产数据隔离后，仍需完成：

- 生产 S3 上传/下载、Redis 队列接管、跨实例恢复、TLS/反向代理和全局限流。
- OTLP/Sentry 投递、CI Runner、真实 Provider 回调、凭据轮换和媒体归档的故障演练。
- 迁移兼容窗口、回滚步骤、对象存储前缀和队列 namespace 记录。

本地 Docker、Mock 或历史测试不能替代生产验收证据。

## P2：明确暂缓

### `[>]` P2-SSO-10 外部身份系统

等待 OAuth 2.0/OIDC 或兼容 JWT 契约后接入，当前保留邮箱登录。

### `[>]` P2-USAGE-11 上游 usage 展示与可选对账

只做供应商 `usage`、状态和可选费用字段的展示/记录；本项目不实现收费、额度扣减或账单结算。该项是可观测性增强，不阻塞功能交付。

### `[>]` P2-RESOURCE-12 资源提及增强能力

- 语义搜索、OCR、音频转录、视频关键帧描述和批量引用。
- 搜索索引异步化、缩略图/元数据重建和大规模资源性能验证。

### `[>]` P2-DESKTOP-13 桌面端封装

Web MVP 和生产链路稳定后再接入 Tauri 桌面壳。

### `[>]` P2-COLLAB-14 协作与后置编辑能力

多人协作、插件市场、代码节点、完整视频剪辑器和复杂移动端画布。

## 外部依赖登记

| 依赖                                                | 影响事项                                              | 处理原则                                 |
| --------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------- |
| Provider 创建/查询/取消/Webhook/签名/usage/幂等契约 | P1-VIDEO-CONTRACT-04、P1-PROVIDER-ROLES-07            | 未确认不猜字段；无法表达时显式失败       |
| 隔离测试 API Key 和平台项目                         | P1-REAL-E2E-08、P1-MULTIKEY-ROTATION-06               | 只通过部署密钥注入；缺失只阻塞真实 E2E   |
| PostgreSQL、Redis/BullMQ、生产 S3 和部署权限        | P0-REAL-INFRA-01、P1-PRODUCTION-09                    | 独立 namespace、bucket、数据库和回滚方案 |
| TLS/反向代理、OTLP/Sentry、CI Runner                | P0-PROD-STARTUP-02、P0-MEDIA-OPS-03、P1-PRODUCTION-09 | 先完成脱敏、失败隔离和演练，再接生产     |
| 价格、预算、本地收费策略                            | 无                                                    | 不作为功能阻断条件；费用由上游负责       |

## 验收规则与执行顺序

1. 每个事项完成时记录修改文件、提交 ID、验证命令、环境类型、外部依赖状态和剩余风险。
2. 只有实现、相关测试/冒烟、文档证据、`git diff --check` 和 Git 状态检查全部具备，才能从 `[~]`/`[!]`/`[>]` 改为 `[x]`。
3. 先完成 P0 生产基础设施与恢复，再完成 P1 Provider 契约、真实请求和多 Key 生产验收；P2 按产品优先级安排。
4. 价格未知、上游未返回费用字段或本地没有收费模块时，继续推进功能；Token、并发、大小和超时限制只作为稳定性保护。
5. Mock 和静态代码可以证明应用内部闭环，不能证明供应商实际读取媒体或生产环境已经验收。

## 验证基线

### 2026-09-05 P0/P1 凭据恢复执行检查点

- 恢复起点：`main` / `424e109`，Node `v24.12.0`、pnpm `11.19.0`、Docker `29.7.2`。接手的凭据轮换代码尚未提交；复查发现文件轮换不写回和数据库轮换可破坏撤销及并发安全，不能沿用“已有实现即完成”的判断。
- 主要修复：文件启动重加密写回前不放行；Prisma API/Worker 写回保留 `id/version/updatedAt`，使用旧密文/key-id/版本/时间 CAS，失败不返回凭据或底层敏感诊断；拒绝重复历史 key-id，补充 GCM 篡改和 key-id 不匹配测试。
- 依赖和迁移：共享 credential-crypto workspace 包、API/Worker 依赖、锁文件和既有 `0014_ai_credential_encryption_key_id` 一并验收；`pnpm install --frozen-lockfile` 通过，无新增第三方版本。先备份再迁移，写入 v2 后不能直接回滚到旧解密器，细则见 `docs/credential-rotation.md`。
- 隔离设施：全新 Compose 项目 `mc-integration-1788571283145`，PostgreSQL/Redis/MinIO 端口 `18432/18379/18900`，与现有开发容器分离；合成凭据仅用于该测试栈。迁移 deploy 成功，schema diff 为零；真实 Prisma/Redis/MinIO 集成 20 passed，包含独立 API/Worker 进程、撤销状态保持和数据库 CAS 竞争。
- 真实入口冒烟：`NODE_ENV=production` 的 API 与 Worker 启动，健康检查和 `401/200` 授权边界通过；不调用 Provider、未启用媒体工具，不包含 TLS 代理或生产部署验收。
- 当前验证：低并发强制全量单测通过，API 402 passed / 11 skipped / 2 个既有 TODO，Credential Crypto 7 passed；其他包结果见 `.data/p0p1-all-tests.log`。普通测试跳过的数据库场景另行执行上述 20 项集成；剩余跳过不可算完成。最终质量与界面验证见本轮提交说明。
- 最终验证：`pnpm exec turbo run lint typecheck build --concurrency=1`、`pnpm format:check` 和 diff 检查通过；桌面 Web Mock E2E 20 passed，追加 Worker 写回失败回归后定向 16 passed。从暂存区导出的独立源码构建通过 API/Worker 类型检查、85 项定向测试和 20 项真实集成，排除对未提交 Provider 代码的依赖。
- 归档与恢复：本检查点随 `v0.13.12` 对应提交归档，提交 ID 可通过 `git rev-list -n 1 v0.13.12` 查询；原有 Provider 取消两文件保留未提交。仅停止本轮新建的隔离 Compose 项目并保留测试卷，不操作既有开发服务；启动冒烟的 API/Worker 子进程已退出。
- 下一步仍需编码/验证：运行中实例的设置/撤销缓存同步、冻结媒体跨 API/Worker 恢复、图片音频归档与参考角色映射、生产媒体工具和可观测性故障隔离。外部依赖另列：真实 Provider 契约/隔离凭据/请求授权、TLS 部署、外部追踪与 CI Runner。P0/P1 保持未完成，不因本轮修复改为 `[x]`。

### 2026-09-05 P0-PROD-STARTUP-02 执行检查点

- 目标：关闭生产 Redis 故障时的本机额度回退，验证跨进程共享窗口、重启恢复和 HTTP 故障边界；不扩展到 P1/P2，不接触生产数据。
- 起点：`main` / `c81411a`，上游 `origin/main`；Node `v24.12.0`、pnpm `11.19.0`、Docker `29.7.2`，依赖已存在，无需安装新包。
- 工作区：接手时已有密钥轮换、Provider 取消、启动配置及迁移等未提交修改，保留但不混入本轮限流提交。
- 实现：`apps/api/src/rate-limit.ts`、`runtime-rate-limit.ts`、`app.ts`、`index.ts` 和 `openapi.ts` 完成生产故障关闭、首次连接等待、1 秒命令超时、冷却恢复、HTTP 503 和脱敏诊断；对应测试、独立 Redis 配置及 CI 步骤随同维护。部署影响和回滚见 `docs/production-rate-limiting.md`，无需数据迁移或新增依赖。
- 恢复记录：最初 `pnpm test` 命中缓存；强制并发重跑遇到 Windows `VirtualAlloc failed` 后，核对工作区并改用低并发重跑通过。集成测试子代理未交付完整文件，主 Agent 停止其执行、检查状态后接手完成，不把等待或缓存作为验收结果。
- 全量测试：`pnpm exec turbo run test --force --concurrency=1 -- --maxWorkers=1 --minWorkers=1` 通过；追加最终 API `vitest run --maxWorkers=1 --minWorkers=1` 为 400 passed、6 skipped、2 个既有 TODO。其他包 Worker 157、Providers 131、Web 290、Domain 24、Observability 15、Credential Crypto 5、UI 3 passed。普通测试跳过的真实 Redis 场景已单独执行；PostgreSQL/S3 等未配置场景不算通过。
- 定向与隔离验证：限流模块 42、入口策略 6、HTTP/OpenAPI/真实监听冒烟 8、OpenAPI 引用 6 均通过；专用 `vitest.rate-limit-integration.config.ts` 在本机 Redis 随机测试前缀下 9 passed，缺配置时按预期非零退出。两个独立 Node 进程共享窗口、重建后额度不重置、不同前缀互不影响；无 `FLUSHDB`、数据清理或生产连接。
- 提交独立性：从暂存区导出的源代码快照重新构建 Domain/Observability/Providers 后，API 类型检查、62 项定向测试和 9 项真实 Redis 验证通过；不依赖接手时未提交的密钥轮换和 Provider 源码修改。
- 质量与界面：`pnpm exec turbo run lint typecheck build --concurrency=1`、`pnpm format:check`、`git diff --check` 通过；`CI=true WEB_PORT=5187 pnpm test:e2e` 为 20 passed，使用独立测试端口避免复用用户开发服务。
- 归档：本检查点随 `v0.13.11` 对应限流修复提交归档；提交 ID 可用 `git rev-list -n 1 v0.13.11` 查询，提交说明包含验证与兼容性边界。详细本地输出位于被忽略的 `.data/todo-*.log`，不提交原始环境或连接凭据。
- 下一步：继续 P0 隔离部署中的 TLS/反向代理、跨实例凭据与队列恢复、告警及回滚演练；缺少授权的真实生产和供应商事项继续保持 `[~]` / `[!]`，本轮不将整个合并清单标为完成。

### 历史已提交基线

- 提交：`06bc654`（`feat: 完善资源提及映射并移除本地收费阻断`），标签：`v0.13.10`。
- `pnpm test`：API 328 passed/5 skipped、Worker 149、Providers 127、Web 290、Domain 24、Observability 15、UI 3。
- `pnpm test:e2e`：20 passed。
- `pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm format:check`、`git diff --check`：通过。
- 上述基线证明当前本地/隔离测试状态，不替代本文件标记为 `[~]` 或 `[!]` 的真实生产和供应商验收。
