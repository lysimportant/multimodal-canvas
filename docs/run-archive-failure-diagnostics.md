# 运行归档失败：可诊断化与重试配置

本文件记录“生成已完成，但结果归档失败”场景下的可诊断信息、可读错误文案与队列重试配置。
它不改变生成与计费语义：失败重试只重新归档，不会重新向上游提交生成请求。

## 背景

真实故障（EP001 段1 · 施压 0–30s，run `b3b9ca5d-ebf3-414b-a010-4fc51754d68f`）：

1. New API 任务已完成并回执，Worker 把结果地址暂存到 Redis（24h TTL），随后开始下载 67.7MB 视频归档。
2. 第一次下载约 2 分 36 秒后，响应体在传输中途被重置（Node `Error('aborted')` / `ECONNRESET`）。
3. 由于是 HTTPS 结果地址，`result-archiver.downloadToFile` 原样抛出底层错误；旧实现把这次错误冻结为
   `payload.firstArchiveError`，之后所有重试的 `run.error` 都显示首错的 `aborted`。
4. 后续重试时上游素材接口已固定返回 `502 artifact_request_rejected`（“Artifact redirect was rejected”），
   但界面上看不到这个真实原因，也无法判断失败发生在哪个阶段。

## Worker 侧行为

### providerJob.payload 归档诊断字段

| 字段                | 类型                                   | 含义                                             |
| ------------------- | -------------------------------------- | ------------------------------------------------ |
| `firstArchiveError` | `string`                               | 首次归档失败原因（保留原语义，不再用于最终提示） |
| `lastArchiveError`  | `string`                               | 最近一次归档失败原因（每次失败更新）             |
| `archiveAttempt`    | `number`                               | 本次失败是第几次队列尝试（1-based）              |
| `archiveStage`      | `'download' \| 'storage' \| 'archive'` | 最近一次失败发生的阶段                           |
| `archiveFailures`   | `{ attempt, message, at }[]`           | 最近 5 次失败记录（`at` 为 ISO 时间）            |

字段经 `sanitizeProviderJobPayload` 白名单持久化，`archiveFailures` 会做形状校验并截断为最近 5 条；
消息经 URL/data/base64 脱敏，不会写入签名参数。

### run.error 文案

- 第 1 次尝试：`生成已完成，归档失败：<最近错误>。仅重试归档，不会重新生成`
- 第 N(≥2) 次尝试：`生成已完成，归档失败（第 N 次尝试）：<最近错误>。仅重试归档，不会重新生成`
- 当最近错误与首次错误不同时，末尾追加 `（首次失败：<首次错误>）`，同时保留本次真实原因和根因线索；
  两者相同时不重复展示。

### 可读错误

- HTTP 失败（非视频 401/403/404/410）：`上游结果下载失败（HTTP <status>）`；响应体为 JSON 时追加
  `，<error.code>：<error.message>`（最多 4KB、消息截断）。
- 下载流中断：`上游结果传输中断（已接收 <N> 字节，<ErrorName>：<message>，code <code>）`。
- 对象存储上传连接中断：`对象存储上传连接中断（<detail>）`。
- 保底文案（watchdog/取消）保持 `provider result download cancelled or timed out`，
  取消仍走 CANCELLED 状态，不会包装成归档失败。

## 队列重试配置

API 在两种入队路径（首次创建 / Outbox 投递恢复）使用同一策略：

- `RUN_QUEUE_ATTEMPTS`：队列尝试次数，默认 `3`，允许 `1~10`。
- `RUN_QUEUE_BACKOFF_MS`：指数退避基数，默认 `2000`，允许 `100~60000`。

非法值会让 API 启动失败并给出明确错误，避免静默截断。`compose.yaml` 已透传这两个变量（留空即默认值）。

## 前端展示

`FailureDiagnostics` 已接入生产界面：`App` 把 `runRecords` 传给画布（`NodeRunContext`），
`AssetNode` 的「节点信息」对话框在最近一次运行失败/取消且命中归档失败时额外展示
（普通失败不渲染，避免信息噪音）：

- 顶部错误 Alert（`run.error` 的脱敏文本）；
- Descriptions 行：`归档阶段`、`归档尝试`、`首次归档错误`、`最近归档错误`（与错误 Alert 重复时省略）；
- 区块「本次运行归档重试记录」：逐条列出 `第 N 次：<错误>` 与本地时间；
- 区块「本次运行参考素材」：参考图名称、版本与资产短 ID。

所有展示文本经过同一套脱敏，不显示签名 URL、query/token 或内联 data URL。

对本次故障之前产生的历史运行：payload 里只有 `firstArchiveError`，因此只显示首次归档错误，
不显示阶段与尝试记录；新产生的归档失败会带全量诊断字段。

## 验证

- `pnpm --filter @multimodal-canvas/worker exec vitest run src/result-archiver.test.ts src/workflow-worker.test.ts src/result-recovery.integration.test.ts`
- `pnpm --filter @multimodal-canvas/web exec vitest run src/FailureDiagnostics.test.tsx src/workspace/AssetNode.test.tsx`
- `pnpm --filter @multimodal-canvas/api exec vitest run src/runs.test.ts`
- 三个包分别执行 `typecheck`。

已完成的真实归档失败无法补归档（上游 artifact 跳转被拒），但后续同类失败会展示真实阶段、最近错误和每次尝试记录，
并可通过环境变量调整自动重试次数与间隔。
