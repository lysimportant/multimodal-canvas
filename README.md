# Multimodal Canvas

一个 Web 优先的多模态生成画布，用于把文字、图片、音频和视频资源组织成可复用、可追踪的生成工作流。

项目的核心体验是：在左侧资源库管理素材，在右侧无限画布上组合节点，通过多个参考输入驱动生成任务，并在任务完成后将结果保存回资源库。所有模型调用都经过本项目 API 和 New API，浏览器不会直接访问上游模型服务。

> 当前状态：已完成 monorepo foundation、资产上传、资产到画布的来源节点切片（`v0.2.0-assets`）、项目/画布保存（`v0.3.0-project-canvas`）和 Mock 运行状态机（`v0.4.0-mock-runs`）。Web 端现在可以创建生成节点、提交单节点运行、查看进度、取消和重试；API 生产入口使用 BullMQ，开发测试默认仍可使用内存运行服务。API 的默认业务存储仍是开发用内存实现，Prisma schema 尚未接入生产运行路径。

## 目标

- 管理文字、图片、音频、视频四类资源，并支持上传、预览、搜索、筛选、标签、归档、恢复和下载。
- 在无限画布上创建 source、generate、transform 三种模式的媒体节点。
- 支持多个上游节点连接到同一个下游节点，并保留输入角色和顺序。
- 在前端和服务端同时校验端口类型、权限和 DAG 环路。
- 创建不可变运行快照，使已提交任务不受后续画布或模型配置变化影响。
- 通过 BullMQ Worker 执行生成任务，支持进度、失败诊断、重试和结果版本。
- 通过设置页管理 New API 连接、模型目录和四类媒体的默认模型。
- 为后续 Tauri 桌面端复用前端和业务后端打下基础。

## 技术栈

| 层级 | 技术 |
| --- | --- |
| Web 前端 | React、TypeScript、Vite |
| 画布 | `@xyflow/react` |
| 状态与数据请求 | Zustand、TanStack Query |
| 表单与校验 | React Hook Form、Zod |
| UI | Tailwind CSS、shadcn/ui、Lucide |
| API | Node.js、TypeScript、Fastify、OpenAPI |
| 数据库 | PostgreSQL、Prisma |
| 异步任务 | Redis、BullMQ、独立 Worker |
| 对象存储 | 生产环境 S3，本地 MinIO |
| 媒体处理 | FFmpeg、ffprobe |
| 实时进度 | SSE；只有确有双向控制需求时才使用 WebSocket |
| 工程化 | pnpm workspace、Turborepo |
| 监控 | Pino、OpenTelemetry、Sentry |
| 桌面端 | MVP 稳定后使用 Tauri |

## 系统边界

```text
浏览器
   │ REST / SSE
   ▼
本项目 API（鉴权、权限、画布、快照、状态推送）
   │ BullMQ
   ▼
Worker（DAG 执行、媒体处理、结果归档）
   │ New API
   ▼
云端模型服务
```

浏览器禁止直连 New API 或其他上游模型。Worker 也不能绕过 New API 调用模型。真实 API Key 只在服务端保存和使用，不进入前端、画布 JSON、日志、文档或截图。

## 目录结构

```text
apps/
  web/                         React Web 应用
  api/                         Fastify REST、鉴权、SSE、Webhook
  worker/                      BullMQ、DAG 执行、模型调用、FFmpeg、归档
packages/
  domain/                      Zod Schema、节点协议、端口协议、状态机
  providers/                   New API Provider
  ui/                          Web/Tauri 共用组件
prisma/
  schema.prisma                PostgreSQL 数据模型
docker-compose.dev.yml         本地 PostgreSQL、Redis、MinIO
.env.example                   环境变量示例
```

## 节点协议

节点类型固定为：

- `text`：文字
- `image`：图片
- `audio`：音频
- `video`：视频

节点模式包括：

- `source`：上传或引用资源
- `generate`：根据输入生成内容
- `transform`：编辑、转录、摘要、扩展或格式转换

参考输入角色至少包括 `prompt`、`negativePrompt`、`content`、`style`、`character`、`firstFrame`、`lastFrame`、`audioTrack`、`transcript` 和 `mask`。

边会保存来源节点、来源端口、目标节点、目标端口和输入顺序，例如：

```json
{
  "id": "edge_01",
  "sourceNodeId": "node_character",
  "sourceHandle": "output:image",
  "targetNodeId": "node_video",
  "targetHandle": "input:character",
  "order": 0
}
```

上游节点变化后，下游节点会标记为 `stale`，但旧结果仍会保留。运行任务时，Worker 使用提交时固化的快照，不读取运行期间变化的画布状态。

## 运行状态

任务状态机计划支持：

```text
draft -> queued -> preparing -> running -> processing -> succeeded
                         │          │            │
                         └──────────┴────────────┴──> failed
                                      │
                                      └──> cancel_requested -> cancelled
```

重试前会检查已有的平台任务 ID，避免重复创建任务和重复扣费。Webhook 需要验签，并通过事件 ID 去重。

## API 规划

统一使用 `/v1` REST API，并提供 OpenAPI 描述：

```text
POST   /v1/projects
GET    /v1/projects/:projectId
GET    /v1/projects/:projectId/canvas
PATCH  /v1/projects/:projectId/canvas

POST   /v1/assets/uploads
POST   /v1/assets/uploads/complete
GET    /v1/assets
PATCH  /v1/assets/:assetId
POST   /v1/assets/:assetId/archive

POST   /v1/nodes/:nodeId/runs
GET    /v1/runs/:runId
POST   /v1/runs/:runId/retry
POST   /v1/runs/:runId/cancel
GET    /v1/projects/:projectId/events

GET    /v1/settings/ai
PATCH  /v1/settings/ai
POST   /v1/settings/ai/test
POST   /v1/settings/ai/models/refresh
GET    /v1/models?mediaType=video

POST   /v1/webhooks/newapi
```

画布保存使用 `revision` 乐观锁；提交旧版本时返回 `409 Conflict`，不能静默覆盖其他版本。

运行接口提交时会校验目标节点，并创建包含画布 revision、目标节点、上游节点、边、输入角色和参数的不可变快照。来源节点不能直接运行；生成或转换节点会进入 `queued` 状态，由 BullMQ Worker 使用 Mock Provider 推进到 `succeeded`、`cancelled` 或 `failed`。重试会创建新的 run，并保留 `retryOf` 与原始快照，不重复修改原任务。

项目创建后，Web 会保存当前项目 ID，并通过上述接口恢复画布。画布提交前会校验节点引用、端口媒体类型和 DAG 环路；服务端返回新的 revision 后，后续提交使用新版本。当前默认 `MemoryProjectStore` 只用于开发垂直切片，接入 PostgreSQL 前不会宣称数据可跨 API 重启持久化。

## 数据与凭据

生产数据库使用 PostgreSQL。核心数据模型包括用户、项目、画布、节点、边、资源、资源版本、运行、运行输入、Provider 任务、用量记录、AI 凭据、模型目录和 Webhook 事件。

- 大文件写入 S3 或本地 MinIO，不把 base64 写入画布 JSON 或普通数据库字段。
- 资产保存 MIME、大小、哈希和 ffprobe 元数据。
- 运行记录保存模型、凭据版本、输入、参数、状态、成本和错误。
- 凭据通过 TLS 传输，并由服务端加密保存。
- 读取接口只返回配置状态或不可逆指纹，不返回原始 API Key。
- 默认使用 Mock Provider，开发和测试不调用真实生产模型。
- 业务 SQLite 数据库、WAL/SHM 文件和上传目录不属于本项目的生产方案。

## 本地开发

### 环境要求

- Node.js 20+
- pnpm 9+
- Docker Desktop
- Git

### 初始化

```bash
git clone https://github.com/lysimportant/multimodal-canvas.git
cd multimodal-canvas
pnpm install
cp .env.example .env
docker compose -f docker-compose.dev.yml up -d
pnpm db:generate
pnpm db:validate
pnpm db:migrate
```

Windows PowerShell 可以使用下面的命令复制环境变量示例：

```powershell
Copy-Item .env.example .env
```

### 启动开发服务

```bash
pnpm dev
```

默认服务地址将在项目脚本完成后固定为：

- Web：`http://localhost:5173`
- API：`http://localhost:3000`
- API 文档：`http://localhost:3000/documentation`

端口和启动命令以仓库内实际配置为准。开发环境应使用独立的 PostgreSQL、Redis namespace、MinIO bucket 和 New API 测试项目。

## 环境变量

`.env.example` 中只放置变量名和示例值。典型配置包括：

```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/multimodal_canvas
REDIS_URL=redis://localhost:6379
S3_ENDPOINT=http://localhost:9000
S3_BUCKET=multimodal-canvas-dev

NEW_API_BASE_URL=https://newapi.example.com/v1
NEW_API_API_KEY=server-side-platform-key
NEW_API_TIMEOUT_MS=120000
NEW_API_TEXT_MODEL=text-model-alias
NEW_API_IMAGE_MODEL=image-model-alias
NEW_API_AUDIO_MODEL=audio-model-alias
NEW_API_VIDEO_MODEL=video-model-alias
NEW_API_VIDEO_PATH=/videos
```

请勿提交真实凭据。视频接口的路径和字段必须以实际 New API 契约为准，未知协议不会在业务层臆造。

## 测试与质量

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

测试范围包括：

- Vitest：Schema、端口兼容性、DAG、模型目录缓存、Provider 状态机。
- React Testing Library：画布 Store、节点、连线、设置页。
- Playwright：上传、拖入画布、多个参考输入、模型切换、运行和结果查看。
- API 集成测试：独立临时 PostgreSQL、Redis namespace、MinIO bucket 和 New API 测试项目。

测试不得清空、覆盖、重置或批量删除真实业务数据库和上传目录；删除用户文件必须使用可恢复的软删除策略。

## 开发路线图

1. 初始化 pnpm + Turborepo monorepo 和 CI。
2. 完成 `packages/domain` 的节点、端口、边、资产和运行 Schema。
3. 创建 Prisma schema 和数据库迁移。
4. 实现 API 鉴权、项目、画布、资产和运行路由。
5. 使用 BullMQ 和 Mock Provider 打通任务状态机（`v0.4.0-mock-runs`）。
6. 完成 Web 资源栏、画布、四类节点、设置页和属性抽屉。
7. 接入 S3/MinIO、ffprobe、SSE 和任务历史。
8. 实现凭据加密、连接测试、模型目录刷新和默认模型。
9. 实现 New API Provider 和模型能力校验。
10. 在取得视频接口契约后实现视频 Provider。
11. 完成模型热切换、四类媒体链路、限流、成本和监控。
12. MVP 稳定后再开发 Tauri 桌面端。

## 非目标

首版不包含多人协作、插件市场、代码节点、完整视频剪辑器和复杂移动端画布。Electron、本地模型和浏览器直连模型也不在技术方案中。

## 贡献与安全

欢迎通过 Issue 反馈问题或提交 Pull Request。涉及凭据、上传文件、Webhook 验签、权限和任务幂等性的修改，需要同时补充对应测试。

请不要在 Issue、日志、截图或提交中公开 API Key、数据库密码、用户上传内容或生产任务信息。发现安全问题时，请先通过仓库维护者提供的私密渠道报告，不要公开发布可利用细节。

## License

许可证将在项目进入可发布阶段后确定。
