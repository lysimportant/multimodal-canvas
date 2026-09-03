# 后续 TODO 计划（未完成项）

更新时间：2026-09-04

本文件是独立的后续执行计划，只收录当前仍未完成、阻塞或暂缓的事项。原先引用的项目总清单 `TODO.md` 当前不在仓库中；历史完成证据需通过 Git 历史或补充文档追溯。

## 范围边界

- PC Web 工作台、单元测试、类型检查、构建和本地宽屏复核已有证据；Mock E2E 当前仍有 1 个回归用例，不暂视为完整通过。
- 隔离环境的视频创建、查询、受保护 content 下载、MinIO 归档、`asset_versions` 写入和同 DAG 多 Key 幂等已有历史测试证据；本机当前无法复跑，且不等同于生产验收。
- 移动端复杂画布按当前优先级后置，不阻塞 PC 交付。

## 状态约定

- `[~]` 已有实现或部分证据，仍需外部环境或生产验收
- `[!]` 被外部契约、凭据或环境阻塞
- `[>]` 明确暂缓，排在当前 MVP 之后

## 执行顺序

### P0：生产基础设施与恢复

- `[~]` **P0-REAL-INFRA-01 生产依赖验收**
  - 范围：PostgreSQL、Redis/BullMQ、生产 S3、跨实例网络与持久化配置。
  - 当前证据：隔离 PostgreSQL/Redis/MinIO、0001-0013 迁移升级、namespace、bucket 初始化和 Mock BullMQ 进程接管已通过。
  - 当前复核：本机未发现 5432、6379、9000、9001 监听，Docker Compose 因 Docker daemon 不可用无法执行；以上证据暂仅限既有隔离测试。
  - 未完成：生产连接、生产数据兼容窗口、生产 S3 上传/下载、生产 Redis 队列和真实平台任务恢复。
  - 验收：在明确隔离的部署环境执行迁移升级、重启恢复、跨实例读写和队列接管；不得连接或清理真实生产数据。

- `[~]` **P0-PROD-STARTUP-02 生产启动与安全边界**
  - 范围：API/Worker 缺失配置 fail-closed、TLS、限流、请求/响应体上限、跨实例会话和密钥注入。
  - 当前证据：代码和单元测试覆盖缺配置拒绝、认证、脱敏和限流边界；无 `DATABASE_URL` 的单机 API 已接入 `FileAiSettingsStore`，默认会将 AI 凭据 AES-GCM 密文、历史版本、模型目录和能力覆盖写入 Git 忽略的 `.data/ai-credentials.json`；未注入显式密钥且本机密钥文件尚不存在时，在存储初始化阶段生成同目录密钥文件，重启可恢复。已有文件但本机密钥丢失、密文无法解密或 JSON 损坏时，存储访问会 fail-closed；无数据库时 `newapi + BullMQ` 启动组合会被拒绝。
  - 未完成：真实生产模式启动、入口 TLS/反向代理部署验证、跨实例全局限流、跨进程历史凭据恢复、密钥轮换后的旧快照恢复、启动前显式等待存储 readiness 和部署环境告警。
  - 已知风险：本地文件模式只支持单机单 API 进程，不能替代 PostgreSQL/BullMQ 的跨进程或多实例恢复；入口目前未显式等待文件存储初始化，损坏或丢密钥的失败行为尚未纳入生产启动验收；凭据使用单一加密密钥，尚无 key-id、旧密钥 fallback 或重加密迁移；Redis 限流故障时会退回进程内限流。
  - 验收：使用不落盘的部署密钥完成 API 与 Worker 启动、重启、轮换和失败演练，日志不得暴露密钥或 Bearer token。

- `[~]` **P0-MEDIA-OPS-03 真实媒体处理与可观测性**
  - 范围：FFmpeg/ffprobe、生产对象存储、OTLP、Sentry、GitHub Runner/CI。
  - 当前证据：媒体元数据、缩略图/poster/waveform 适配器及注入式测试已存在；真实二进制和外部服务尚未验收。
  - 未完成：真实 FFmpeg/ffprobe 二进制和生产媒体归档、外部追踪/告警投递、GitHub Runner 隔离集成执行。
  - 验收：在隔离部署中完成图片缩略图、视频 poster、音频波形、ffprobe 元数据、失败告警和 CI 集成测试；外部投递失败不得影响主流程。

### P1：供应商契约与媒体覆盖

- `[!]` **P1-VIDEO-CONTRACT-04 New API 视频完整契约**
  - 当前证据：通用 Base URL 下的创建、查询 `done`、受保护 content 下载，以及本地取消/重试、Webhook/HMAC 签名与事件幂等、状态/错误/usage 归一化已有代码和注入式测试；隔离 Worker/MinIO/`asset_versions` 仍有历史测试证据。
  - 未完成：真实供应商取消接口、签名规范与回调契约、完整状态/错误/usage 计费字段、真实失败重试、真实隔离凭据 E2E、生产任务恢复和供应商扣费幂等。
  - 依赖：平台提供并确认这些外部契约和可用测试凭据。
  - 验收：同一隔离项目完成创建、轮询或 Webhook、取消、失败、重试、下载、归档、去重和计费字段核对；未知字段不得臆造。

- `[~]` **P1-MEDIA-COVERAGE-05 图片、音频与参考输入**
  - 当前证据：图片/音频请求参数与响应解析、base64/URL 受控下载和 Worker 归档边界已有 Provider/Worker 注入式测试；既有真实最小图片请求曾返回 HTTP 200/base64。
  - 未完成：完整图片可选参数、图片 URL 可访问性、图片 Worker 归档、真实音频请求/响应/归档，以及多 `reference_images` 的供应商字段映射。
  - 验收：分别使用隔离凭据完成图片和音频创建、解析、受控下载、归档和资产版本；不支持的参考角色必须显式失败。

- `[~]` **P1-MULTIKEY-ROTATION-06 多 Key 轮换与历史恢复**
  - 当前证据：两把凭据在同一 DAG 中分别冻结 `credentialId/version`，文字+视频执行和重复幂等提交已通过；`FileAiSettingsStore` 的 6 个测试还覆盖了本地单进程 API 重启后的历史凭据精确读取、模型目录恢复、激活/撤销后冻结引用解析、坏密钥/损坏文件 fail-closed 和并发写入版本保留。
  - 未完成：真实密钥轮换、撤销后的排队任务策略、多进程/多实例恢复、生产队列恢复和供应商侧多 Key 扣费行为；本地文件模式不能替代 PostgreSQL/BullMQ 的恢复验收。
  - 验收：轮换后新任务使用新版本，旧快照只使用其冻结版本；撤销、重启和失败恢复均 fail-closed 或按明确策略处理，日志和导出不包含原 Key。

- `[~]` **P1-PROVIDER-ROLES-07 统一端口角色的真实映射**
  - 范围：`prompt`、`negativePrompt`、`content`、`style`、`character`、`firstFrame`、`lastFrame`、`audioTrack`、`transcript`、`mask`。
  - 当前证据：本地 Provider 对未支持角色 fail-closed，并覆盖 text 的 `prompt`/`content`/`transcript`、image/audio 的主输入、video 的 `prompt`/`content`/`firstFrame` 映射，以及顺序和重复输入校验。
  - 未完成：真实供应商对 `negativePrompt`、`lastFrame`、`audioTrack`、`style`、`character`、`mask`、多参考图和跨媒体输入的字段契约；不能把角色静默降级或丢弃。
  - 验收：每种角色都有已确认的映射或可诊断的不支持错误，并覆盖顺序、重复输入、非法组合和重试行为。

### P2：明确暂缓

- `[>]` **P2-SSO-08 外部身份系统/单点登录**：等待 OAuth 2.0/OIDC 或兼容 JWT 契约后再接入，保留现有邮箱登录。
- `[>]` **P2-BILLING-09 收费、累计额度与完整 usage 对账**：等待产品策略和供应商账单契约；当前仅保留单次成本上限与并发保护。
- `[>]` **P2-DESKTOP-10 Tauri 桌面壳**：Web MVP 和生产链路稳定后复用现有前端。
- `[>]` **P2-COLLAB-11 协作与后置编辑能力**：多人协作、插件市场、代码节点、完整视频剪辑器和复杂移动端画布。

## 本轮本地运行状态

以下是 2026-09-04 的只读复核结果，不代表上述生产待办已完成：

- 代码质量：`pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm build` 通过；构建仅有 Web 大 chunk 警告。
- 单元测试：`pnpm test` 通过；API `286 passed / 5 skipped`（含 `file-ai-settings.test.ts` 的 6 个本地凭据持久化测试），Web `264 passed`，Worker `130 passed`，Providers `110 passed`，Domain `19 passed`，Observability `15 passed`，UI `3 passed`。
- Mock E2E：最近一次 `pnpm test:e2e` 为 `19 passed / 1 failed`。失败用例位于 `apps/web/e2e/smoke.spec.ts:1197`，模型快速编辑器选择器未找到；在独立端口复跑仍失败，需修复 UI/测试契约后才能恢复“Mock E2E 已完成”的结论。
- Web/API：本次检查时 5173 和 3000 均无监听，未重新启动开发服务器，未复核 Web HTTP 200 或 API `/health`；先前的 5173=200、3000 `/health`=404 仅为历史记录，不作为当前证据。
- 依赖服务：本机无 PostgreSQL/Redis/MinIO 监听，Docker daemon 当前不可用，因此未启动持久化 BullMQ Worker，也未完成本地隔离集成复跑。
- 本轮仅更新 `TODO-NEXT.md`，未修改代码、配置或其他 TODO 文件；`git diff --check` 通过，提交后工作区保持干净。

## 完成门槛

每个条目只有在依赖、实现、对应测试/冒烟验证、文档证据和 `git diff --check` 均完成后，才可从 `[~]`/`[!]`/`[>]` 改为 `[x]`；Mock、静态代码或历史测试不能替代真实外部契约和生产环境证据，外部契约未知或生产环境未提供时保持原状态。
