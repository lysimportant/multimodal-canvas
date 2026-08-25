# AGENTS.md

## 项目目标

从零开发一个 Web 优先的多模态生成画布：

- 左侧资源菜单管理文字、图片、音频、视频。
- 右侧无限画布编辑生成工作流。
- 支持文字、图片、音频、视频四类节点。
- 多个上游节点可以同时连接到一个下游节点作为参考输入。
- 所有生成请求使用云 API，并统一经过 New API。
- Web MVP 完成后使用 Tauri 复用前端开发桌面端。

当前目录只有本文件，没有现成代码。必须从零创建项目。

## 固定技术栈

| 领域 | 方案 |
|---|---|
| 前端 | React + TypeScript + Vite |
| 画布 | `@xyflow/react` |
| 状态 | Zustand + TanStack Query |
| 表单校验 | React Hook Form + Zod |
| UI | Tailwind CSS + shadcn/ui + Lucide |
| API | Node.js + TypeScript + Fastify + OpenAPI |
| ORM/数据库 | Prisma + PostgreSQL |
| 队列 | Redis + BullMQ + 独立 Worker |
| 文件 | 生产 S3；本地 MinIO |
| 媒体 | FFmpeg + ffprobe |
| 进度 | 默认 SSE；只有双向控制确有需要时才用 WebSocket |
| 工程 | pnpm workspace + Turborepo |
| 监控 | Pino + OpenTelemetry + Sentry |
| 桌面 | MVP 稳定后使用 Tauri |

不得改成 Electron、SQLite/Dexie 主存储、本地模型或浏览器直连模型。

## 目录结构

```text
apps/web       React Web 应用
apps/api       Fastify REST、鉴权、SSE、Webhook
apps/worker    BullMQ、DAG 执行、模型调用、FFmpeg、归档
packages/domain   Zod Schema、节点协议、端口协议、状态机
packages/providers New API Provider
packages/ui       Web/Tauri 共用组件
prisma/schema.prisma
docker-compose.dev.yml
.env.example
```

## 产品交互

### 资源菜单

- 上传、预览、搜索、筛选、重命名、标签、归档、恢复、下载。
- 资源支持文字、图片、音频、视频。
- 拖入画布创建来源节点。
- 图片显示缩略图，视频显示 poster，音频显示波形，文字可复制。

### 画布

- 支持平移、缩放、框选、多选、复制、粘贴、删除、撤销、重做、自动保存。
- 顶部显示项目名、保存状态、运行、导出。
- 选中节点后显示属性抽屉。
- 节点显示预览、运行状态、进度、错误、重试和结果版本。
- 可以运行单节点或运行到指定节点。
- 创建连线前后都要校验端口类型，并阻止环路。
- 首版不做多人协作、插件市场、代码节点、完整视频剪辑器和手机复杂画布。

### 设置页

设置页必须支持：

- New API Base URL。
- New API API Key 密码输入。
- 连接测试。
- 刷新模型列表。
- 按文字、图片、音频、视频选择默认模型。
- 删除凭据和查看连接状态。

节点模型选择支持“继承项目默认模型”或“单独覆盖模型”。

## 节点和参考输入

节点类型固定为：

```text
text       文字
image      图片
audio      音频
video      视频
```

模式：

```text
source      上传或引用资源
generate    根据输入生成内容
transform   编辑、转录、摘要、扩展或格式转换
```

端口角色至少包括：

```text
prompt          主提示词
negativePrompt  负面提示词
content         内容参考
style           风格参考
character       角色参考
firstFrame      视频首帧
lastFrame       视频尾帧
audioTrack      配音或背景音
transcript      转录文本
mask            图片遮罩
```

多个节点可以连接同一个目标端口；必须保存角色和输入顺序。边至少包含：

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

规则：

- 类型不兼容时前端和服务端都拒绝连接。
- 服务端使用拓扑排序验证 DAG。
- 上游变化后，下游标记为 `stale`，旧结果保留。
- 运行时固化所有上游输入，不能读取运行期间变化的画布状态。

## New API 和模型热切换

### 调用边界

```text
浏览器 -> 本项目 API -> BullMQ Worker -> New API -> 云端模型
```

禁止浏览器直接调用 New API 或上游模型，禁止 Worker 绕过 New API。

### 配置

只提交 `.env.example`，真实 Key 不得写入代码、文档、日志、截图或前端：

```env
NEW_API_BASE_URL=https://newapi.example.com/v1
NEW_API_API_KEY=server-side-platform-key
NEW_API_TIMEOUT_MS=120000
NEW_API_TEXT_MODEL=text-model-alias
NEW_API_IMAGE_MODEL=image-model-alias
NEW_API_AUDIO_MODEL=audio-model-alias
NEW_API_VIDEO_MODEL=video-model-alias
NEW_API_VIDEO_PATH=/videos
```

### 模型目录

- 服务端使用当前凭据调用 `GET {NEW_API_BASE_URL}/models`。
- 规范化模型 ID、名称、媒体能力、限制、价格和刷新时间。
- 模型目录需要缓存并支持手动刷新；刷新失败保留旧列表。
- 如果平台没有返回完整能力，使用 `model_capability_overrides` 补充。
- 模型列表按节点媒体类型过滤。
- 模型不可用时禁止静默替换，提交前显示明确错误。

### 热切换规则

- 修改默认模型只影响新任务。
- 节点可以覆盖项目默认模型。
- 已排队或运行中的任务使用提交时保存的模型、凭据版本和参数。
- 运行快照只保存 `credentialId`、凭据版本和模型别名，不保存 API Key。

### 设置 API

```text
GET   /v1/settings/ai
PATCH /v1/settings/ai
POST  /v1/settings/ai/test
POST  /v1/settings/ai/models/refresh
GET   /v1/models?mediaType=video
```

API Key 必须 TLS 传输、服务端加密保存；读取接口不能返回原文，只返回已配置状态或不可逆指纹。

### Provider

实现两个 Provider，二者使用同一个 New API Base URL 和平台 API Key：

```text
NewApiProvider       文字、图片、音频
NewApiVideoProvider   视频异步任务
```

Provider 负责把统一端口角色映射为平台字段。业务层、画布协议和 Worker 不能出现上游供应商专用字段。

视频流程：

```text
提交任务 -> 保存平台任务 ID -> 查询/Webhook -> 更新进度
        -> 完成后下载 -> 写入 S3 -> ffprobe -> 创建资产版本
```

视频接口路径和字段未知时不得臆造；只在 `NewApiVideoProvider` 中实现，先使用 Mock Provider 打通状态机。

## 后端运行模型

1. API 校验权限、画布、端口、资源、模型能力和额度。
2. API 创建不可变运行快照、幂等键和 `runId`。
3. API 将任务写入 BullMQ，立即返回 `runId`。
4. Worker 对上游依赖拓扑排序并执行。
5. Worker 调用 New API，保存平台任务 ID。
6. 长任务通过 Webhook 或退避轮询更新。
7. 结果写入 S3，创建资源版本和用量记录。
8. API 通过 SSE 推送任务状态。

状态：

```text
draft -> queued -> preparing -> running -> processing -> succeeded
                         |          |            |
                         +----------+------------+-> failed
                                      |
                                      +-> cancel_requested -> cancelled
```

重试必须先检查已有平台任务 ID，避免重复创建和重复扣费。Webhook 必须验签并按事件 ID 去重。

## 数据模型

PostgreSQL + Prisma 至少包含：

```text
users
projects
canvases
nodes
edges
assets
asset_versions
runs
run_inputs
provider_jobs
usage_ledger
ai_credentials
model_catalog
model_capability_overrides
project_model_defaults
webhook_events
```

关键规则：

- 业务表带 `createdAt`、`updatedAt`；可归档数据带 `archivedAt`。
- 大文件存 S3，不把 base64 写入画布 JSON 或数据库普通字段。
- 资产记录 MIME、大小、哈希和 ffprobe 元数据。
- 运行记录模型、凭据版本、输入、参数、状态、成本和错误。
- 删除节点不删除资产；永久删除必须明确授权。

## API

统一使用 `/v1` REST + OpenAPI：

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

POST   /v1/webhooks/newapi
```

所有接口先做认证和项目级授权。画布保存使用 `revision` 乐观锁，旧版本提交返回 `409 Conflict`，不得静默覆盖。

## 开发顺序

1. 创建 pnpm + Turborepo monorepo 和 CI。
2. 创建 `packages/domain`，完成 Zod 节点、端口、边、资产、运行 Schema。
3. 创建 Prisma schema 和 migration。
4. 创建 API 鉴权、项目、画布、资产和运行路由。
5. 创建 Worker、BullMQ 和 Mock Provider，先跑通任务状态机。
6. 创建 Web 资源栏、画布、四类节点、设置页和属性抽屉。
7. 接入 S3/MinIO、ffprobe、SSE 和任务历史。
8. 实现凭据加密、连接测试、模型目录刷新和默认模型。
9. 实现 NewApiProvider 和模型能力校验。
10. 取得视频接口契约后实现 NewApiVideoProvider。
11. 完成模型热切换、四类媒体端到端链路、限流、成本和监控。
12. MVP 稳定后再开发 Tauri，不重新实现业务后端。

## 测试与安全

- Vitest：Schema、端口校验、DAG、缓存、Provider 状态机。
- React Testing Library：画布 Store、节点、连线、设置页。
- Playwright：上传、拖入、多个参考、模型切换、运行、查看结果。
- API 集成测试使用独立临时 PostgreSQL、Redis namespace、MinIO bucket 和 New API 测试项目。
- 默认使用 Mock Provider，不调用真实生产 API。
- 禁止把真实 API Key 写入仓库或输出。
- 禁止清空、覆盖、重置或批量删除真实数据库和上传目录。
- 禁止执行 `git reset --hard`、`git checkout --` 等会丢失用户修改的命令。

## 完成标准

1. 四类资源可以上传、预览并拖入画布。
2. 至少三个不同类型节点可以同时作为一个生成节点的参考。
3. 非法连接和循环依赖在前后端都被阻止。
4. 设置页可以填写 API Key、测试连接、刷新模型和选择默认模型。
5. 节点可以继承或覆盖模型，模型热切换不影响已提交任务。
6. 视频完整经过 New API 创建、查询、Webhook/轮询、完成和下载。
7. 结果自动进入资源库并保留来源、版本、模型、参数和费用。
8. 任务失败可诊断、可重试且不重复创建平台任务。
9. Web 页面关闭后重新打开仍能恢复项目和任务状态。
10. Web 前端可以在后续 Tauri 壳中复用。
