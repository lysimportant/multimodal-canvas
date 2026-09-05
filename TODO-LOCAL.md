# Local 未完成任务

更新时间：2026-09-05

本文件只记录开发机、测试容器、等效 CI 和获授权测试 Provider 请求中的实现与验收。

状态说明：

- [ ] 尚未执行。
- [~] 已有可复用的实现或证据，仍需完成本文件列出的验收。

## P0：测试设施与任务恢复

### [~] P0-ISOLATED-RECOVERY-01 真实供应商视频任务跨进程恢复

- 在专用 PostgreSQL、Redis 和对象存储 namespace 中，对真实供应商异步视频任务执行 Worker 崩溃后的接管、查询、下载和归档。
- 验收任务身份不丢失、不重复创建、不重复记录 usage。
- 保存一次中断或接管演练的任务身份、命令、报告和归档对象键。

## P1：Provider 适配与媒体输入

### [~] P1-ADAPTER-CONTRACT-04 视频适配器契约

- 固化取消接口、Webhook 原始 body 签名与编码、时间戳重放保护、幂等范围、重复计费规则和安全重试规则。
- 为确认的契约补充取消、状态、签名、重放、幂等和结果不明的回归测试。
- 当前仅验证 sub2 的 legacy-v1 创建、查询、内容下载和归档；取消、Webhook 与重试行为必须有独立测试证据。

### [ ] P1-ISOLATED-AUDIO-05 音频与参考输入

- 确认 TTS 模型、voice、格式和语速组合，完成一次真实音频生成及 Worker、Prisma、对象存储归档。
- 为多参考图、负面提示、尾帧、音轨、角色绑定、蒙版及其它扩展字段补齐字段映射、拒绝和结果解析测试。
- 未授权的音频模型、voice 或扩展字段必须在请求前失败。

### [~] P1-INPUT-MAPPING-07 角色与扩展字段映射

- 整理 negativePrompt、lastFrame、audioTrack、style、character、mask 和多参考图的字段契约、模型适用范围和样例响应。
- 对每个确认字段补充序列化、未知字段拒绝和响应解析测试。
- 未确认的角色和参数继续在请求前显式拒绝，不能静默降级。

## Local 完成判定

- 所有启用的测试必须有非空报告、零失败、零 skip/TODO；普通测试中的设施跳过不算通过。
- PostgreSQL、Redis、S3/MinIO、队列和凭据使用专用 namespace、bucket/prefix 和合成或获授权的测试凭据。
- 涉及费用或外部状态时记录授权、请求身份和结果；结果不明不得重复发送可能计费的创建请求。
- 关闭任务时记录验证命令、环境、证据文件和结果。

## 执行准备

- 供应商任务查询接口及一次中断或接管演练授权。
- 已确认的 TTS 模型、voice、格式、测试 Key 和一次请求授权。
- Provider 的状态、取消、回调、签名和幂等正式契约。
- 可复现的 PostgreSQL、Redis、S3/MinIO、FFmpeg/ffprobe 测试配置。

## 2026-09-05 本地执行检查点

本轮从 `main @ 4f4da4f` 恢复，工作区起始状态干净；Node `v24.12.0`、pnpm `11.19.0`、Docker Server `29.7.2`。已使用专用 Compose 项目 `mc-acceptance-test-p0p1`，PostgreSQL `127.0.0.1:19432`、Redis `127.0.0.1:19379`、MinIO `127.0.0.1:19900`，仅使用合成凭据和隔离 bucket/prefix。

已通过的本地命令与结果：

- `pwsh -NoProfile -File scripts/verify-isolated.ps1 -Action Start -Project mc-acceptance-test-p0p1`：设施健康、MinIO bucket 初始化成功。
- `pwsh -NoProfile -File scripts/verify-isolated.ps1 -Action Test -Project mc-acceptance-test-p0p1`：隔离 PostgreSQL 35 项、Redis 9 项、生产入口 22 项通过；迁移无 pending，schema 无差异。
- `pwsh -NoProfile -File scripts/verify-media-ops.ps1 ...`：API 媒体/存储 40 项、Worker 归档/输出 35 项、Observability 21 项通过；使用本地 FFmpeg/ffprobe 9.0.1。
- `pwsh -NoProfile -File scripts/verify-s3-permissions.ps1 -Project mc-acceptance-test-p0p1`：29 项通过，临时用户、策略、bucket 和对象均已精确清理；报告写入 `.data/s3-permissions-0e8686148e4d4531a44c954d5a5a1185.json`。
- `pnpm --filter @multimodal-canvas/providers test --maxWorkers=1 --minWorkers=1`：266 passed、0 failed、0 skipped；providers typecheck、lint、build 均通过。
- `pnpm --filter @multimodal-canvas/domain test --maxWorkers=1 --minWorkers=1`：24 passed；Worker 全量：183 passed。

本轮没有发送任何外部 Provider 请求，也没有修改数据库 schema、依赖或用户数据。上述结果只能关闭本地设施和回归检查点，不能把真实供应商取消、Webhook、幂等/重复计费、跨进程崩溃接管或真实 TTS 音频验收标记为完成。

下一步仍需用户提供：真实视频任务中断/接管演练授权与查询接口；已确认的 TTS 模型、voice、格式、测试 Key 及单次请求授权；Provider 正式的状态、取消、Webhook 原始签名/编码、时间窗口、幂等范围和重复计费契约。未获得这些输入前，保持 P0-ISOLATED-RECOVERY-01、P1-ADAPTER-CONTRACT-04、P1-ISOLATED-AUDIO-05、P1-INPUT-MAPPING-07 的现有状态，不重复创建可能计费的任务。

## P2：后置能力

### [ ] P2-SSO-10 外部身份系统

- 获得 OAuth 2.0/OIDC 或兼容 JWT 正式契约后接入。

### [ ] P2-USAGE-11 上游 usage 展示与对账增强

- 在产品优先级允许时补充 usage 展示、费用字段展示和可选对账；不实现收费、额度扣减或账单结算。

### [ ] P2-RESOURCE-12 资源提及增强能力

- 语义搜索、OCR、音频转录、视频关键帧描述、批量引用、索引异步化和大规模性能验证。

### [ ] P2-DESKTOP-13 桌面端封装

- Web MVP 稳定后接入 Tauri 桌面壳。

### [ ] P2-COLLAB-14 协作与后置编辑能力

- 多人协作、插件市场、代码节点、完整视频剪辑器和复杂移动端画布。
