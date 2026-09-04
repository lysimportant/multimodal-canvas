# Agent 公共底座与联网能力计划

版本：0.1
状态：方案待评审，未开始实现
适用范围：画布节点 Agent、独立页面 Agent 及后续其他 Agent 入口
产品优先级：PC Web 优先，移动端后置

## 1. 文档关系

本文件只描述两种 Agent 共同依赖的底座、协议、联网能力、安全边界和验收标准。

- [画布节点 Agent 计划](TODO-AGENT-CANVAS-NODE.md)：描述画布节点、上游输入、画布权限和结果回写。
- [独立页面 Agent 计划](TODO-AGENT-STANDALONE.md)：描述脱离画布的 Session、聊天界面、联网开关和研究体验。

两份产品文档必须引用本文件的公共契约，不得各自重新定义 Agent Run、工具事件、联网策略、来源引用或上下文用量。

## 2. 背景与目标

项目已经有 Fastify API、BullMQ Worker、DAG 执行、Provider 抽象、Run 快照、Asset/AssetVersion、ProviderJob、模型目录和凭据版本冻结能力。本计划在这些能力之上增加 Agent，而不是另起一套任务和资产体系。

公共底座需要解决以下问题：

1. Agent 能根据自然语言规划多步工具调用。
2. Agent 能在明确授权后联网搜索和读取公开网页。
3. Agent 能读取用户明确选择的文件、资产、画布输入和 `@`资源引用。
4. 用户能看到当前动作、搜索记录、来源、文件引用和上下文用量。
5. 工具、模型和供应商可以替换，不让产品层绑定单一厂商。
6. Worker 重启、SSE 断线、暂停、恢复、取消和重试不会破坏 Run 记录或重复产生副作用。
7. 图片、音频、视频等产物继续走现有 ProviderJob、Asset 和 AssetVersion 归档链路。

## 3. 最终技术决策

### 3.1 编排与执行

| 层            | 方案                                | 责任                                                |
| ------------- | ----------------------------------- | --------------------------------------------------- |
| Agent Runtime | `LangGraph.js`                      | 状态图、工具循环、暂停、恢复、检查点和长流程        |
| 后台任务      | 现有 `BullMQ Worker`                | 排队、重试、取消、超时和进程接管                    |
| 持久化        | 现有 PostgreSQL/Prisma              | Session、Run、Event、Checkpoint、Source、Context    |
| 模型调用      | Provider Adapter                    | OpenAI、Anthropic、xAI/Grok、DeepSeek、智谱 GLM/ZLM |
| 媒体产出      | 现有 ProviderJob/Asset/AssetVersion | 图片、音频、视频和文件归档                          |
| 前端通道      | HTTP + SSE                          | 创建运行、流式事件、断线重连和事件回放              |

不建议把 DeepSeek Agent Tool 或 OpenAI Agents SDK 作为全项目唯一底座。它们可以作为某个 Provider 的调用实现或参考路径，但公共协议必须由项目自身掌握。

### 3.2 联网能力

联网能力属于独立的工具层，不属于某个 LLM Provider 的私有字段：

```text
web.search
web.open
web.findInPage
file.search
asset.read
canvas.read
artifact.create
media.generate
```

OpenAI 原生 `web_search` 可以适配到上述 `web.*` 协议；其他供应商由 Agent Runtime 主动发起统一工具调用。这样可以在不改 Agent 业务逻辑的前提下切换模型供应商或搜索服务。

### 3.3 搜索服务

首个搜索服务应通过 `WebSearchAdapter` 接入。建议先对 Tavily、Exa、Brave、Bing 和自建 SearXNG 做最小评测，再选一个作为 MVP 默认服务；搜索服务名称不能写死在画布或页面代码中。

## 4. 术语和边界

### 4.0 当前费用边界

- 本项目当前不向用户收费、不做本地额度扣减或账单结算；模型、搜索和媒体请求的费用由对应上游 API/服务商计算和结算。
- Agent Runtime 只透传并记录供应商返回的 `usage`、状态、请求 ID 和可选费用字段，用于运行详情、审计、诊断和幂等追踪；价格未知或供应商未返回费用字段不阻塞功能实现。
- 步数、Token、搜索次数、上下文、并发和超时属于运行资源限制，用于防止失控任务，不是本地收费授权条件。

### 4.1 AgentDefinition

可复用的 Agent 定义，包含：

- 名称、描述、版本和发布状态。
- 系统指令和输出格式。
- 默认模型别名。
- 可用工具及其权限组。
- 默认联网模式。
- 最大步数、超时、Token、并发和其他运行资源上限；本项目不设置金额预算或本地收费额度。
- 允许的媒体输入和 Artifact 类型。
- 可使用的入口：`canvas`、`standalone` 或两者。

AgentDefinition 必须版本化。一次运行固定一个版本，不能因为后续修改 Prompt 而改变历史 Run 的解释结果。

### 4.2 AgentSession

多轮会话容器，主要用于独立页面。Session 保存聊天历史、用户设置和可复用上下文，但不等于一次执行。

### 4.3 AgentRun

一次不可变执行。画布节点和独立页面都必须创建自己的 Run；不能让两个入口共享同一个正在变化的 Run。

### 4.4 AgentStep

Run 中的一个可观测步骤，例如任务解析、搜索、打开页面、文件检索、媒体生成或最终整理。Step 不是模型隐藏思维链的转储，只保存用户需要理解和审计的摘要。

### 4.5 ToolDefinition

服务端注册的工具定义，必须包含：

- 名称、版本、输入/输出 JSON Schema。
- 读取或写入权限。
- 是否有外部副作用。
- 是否幂等、是否可重试。
- 超时、并发和运行资源限制。
- 是否必须人工审批。

### 4.6 Source、Citation 和 FileReference

- `Source`：Agent 检索或读取过的网页、文件、画布节点或资产。
- `Citation`：最终回答实际引用的来源位置。
- `FileReference`：文件或资产版本在本次 Run 中的结构化引用，必须包含版本和定位信息。

搜索过的来源不一定会被最终引用，二者必须分别记录。

## 5. 公共架构

```text
React Web
├── 画布 Agent 节点
└── 独立 Agent 页面
        │ HTTP / SSE
        ▼
Fastify API
├── Agent Definition API
├── Session / Run API
├── Tool / Approval API
├── Source / Context API
└── Event Stream API
        │ BullMQ
        ▼
Agent Worker
└── LangGraph Runtime
    ├── Preflight
    ├── Context Manager
    ├── Network Policy Engine
    ├── Planner
    ├── Tool Registry
    ├── WebSearchAdapter
    ├── PageReaderAdapter
    ├── FileRetrievalAdapter
    ├── Provider Adapter
    ├── Checkpoint Store
    ├── Event Store
    └── Artifact/Provenance Builder
        │
        ▼
PostgreSQL / Redis / Object Storage
Asset / AssetVersion / ProviderJob / Run
```

浏览器只负责交互、文件选择和事件展示。模型调用、联网、API Key、工具执行和 Agent Loop 必须在 API/Worker 侧完成。

## 6. 公共运行状态机

建议统一使用以下状态：

```text
READY
RUNNING
WAITING_APPROVAL
PAUSED
SUCCEEDED
FAILED
CANCEL_REQUESTED
CANCELLED
TIMED_OUT
```

状态转换约束：

- `READY -> RUNNING`：通过预检并进入 Worker。
- `RUNNING -> WAITING_APPROVAL`：工具或结果需要人工确认。
- `WAITING_APPROVAL -> RUNNING`：用户批准后继续。
- `RUNNING -> PAUSED`：用户主动暂停或系统进入可恢复等待。
- `PAUSED -> RUNNING`：从最新检查点恢复。
- `RUNNING -> SUCCEEDED/FAILED/CANCELLED/TIMED_OUT`：终态只能写入一次。
- 终态 Run 不允许原地改变联网策略、模型、工具白名单或输入引用；需要 Fork 或新建 Run。

## 7. 联网模式和 NetworkPolicy

### 7.1 四种模式

| 模式              | 可用能力                                     | 推荐用途               |
| ----------------- | -------------------------------------------- | ---------------------- |
| `offline`         | 对话、已选文件、项目资产、画布输入           | 默认安全模式           |
| `search_read`     | 搜索、打开网页、正文抽取、来源引用           | 常规联网问答           |
| `deep_research`   | 多轮搜索、页内查找、跨来源比较、较高搜索上限 | 报告和调研             |
| `browser_actions` | 隔离浏览器中的页面观察和交互                 | 后续版本，必须单独审批 |

`browser_actions` 不应隐含开启；搜索与读取网页和真实浏览器点击是两种不同风险等级的能力。

### 7.2 NetworkPolicySnapshot

每次 Run 创建时冻结：

```json
{
  "mode": "search_read",
  "allowedDomains": [],
  "blockedDomains": [],
  "locale": "zh-CN",
  "timeRange": null,
  "maxSearchQueries": 5,
  "maxOpenedPages": 10,
  "maxSources": 20,
  "maxRunSeconds": 300,
  "allowRemoteFileDownload": false,
  "allowFileOutbound": false,
  "requireApprovalForExternalSideEffects": true
}
```

字段可按产品需要扩展，但运行中的策略必须是不可变快照。

### 7.3 联网预检

在真正产生外部请求前，API 返回预检摘要：

```text
模型：Anthropic / 某模型
联网：搜索与读取网页
搜索服务：已配置的 WebSearchAdapter
可能外发：用户输入中的搜索词；用户明确选择的文件片段（当前为否）
上限：最多 5 次搜索、10 个页面、300 秒
预计上下文：约 18,000 tokens（估算）
```

联网关闭时，服务端必须拒绝 `web.*` 工具调用，而不能只隐藏前端按钮。

## 8. Web 工具公共契约

### 8.1 web.search

输入至少包括：

```json
{
  "query": "需要检索的关键词",
  "locale": "zh-CN",
  "timeRange": "past_year",
  "allowedDomains": [],
  "blockedDomains": [],
  "maxResults": 10
}
```

输出至少包括：

- 标准化 query。
- 结果标题、URL、域名、摘要和发布时间（若可得）。
- 搜索服务和响应耗时。
- 结果是否被策略过滤。
- 可复用的 `sourceId`。

### 8.2 web.open

必须在服务端校验：

- 只允许 `http`/`https`。
- 禁止私有 IP、回环地址、云元数据地址和本地文件协议。
- 限制重定向次数、响应大小、内容类型和读取时间。
- 记录最终 URL、原始 URL、状态码、内容 Hash 和抓取时间。

### 8.3 web.findInPage

只对已打开且保存了正文抽取结果的来源执行，返回匹配片段和位置，不重新绕过 NetworkPolicy 访问未知域名。

### 8.4 页面内容处理

网页内容和搜索摘要一律视为不可信资料。页面中的“请忽略系统指令”“请调用某工具”“请上传文件”等文本不能获得任何工具权限。

## 9. 搜索记录和来源模型

每次搜索至少记录：

- `runId`、`stepId`。
- query、语言、时间范围和域名过滤。
- 搜索服务、开始/结束时间和耗时。
- 返回结果数量、过滤数量和错误。
- 哪些结果被打开。
- 哪些来源进入上下文。
- 哪些来源被最终引用。

来源分组必须包含：

```text
最终引用来源
已检索但未引用来源
读取失败来源
被策略阻止来源
用户手动添加来源
```

来源卡片应显示标题、域名、URL、发布时间、访问时间、来源类型、片段位置、引用次数和内容状态。

## 10. 文件、资产和 @ 引用公共协议

文件或资产不能只以文件名字符串进入模型。引用至少包含：

```json
{
  "referenceId": "mention-uuid",
  "assetId": "asset-uuid",
  "assetVersionId": "asset-version-uuid",
  "displayName": "产品说明书.pdf",
  "mediaType": "document",
  "contentHash": "sha256",
  "location": {
    "page": 4,
    "section": "价格政策"
  },
  "semanticRole": "reference",
  "permissionSnapshot": "..."
}
```

`@` 资源引用的统一流程：

```text
输入 @
  -> 按当前项目权限查询资源索引
  -> 用户选择并确认
  -> 插入资源卡片
  -> 可选绑定语义角色
  -> 保存引用身份和顺序
  -> 运行时冻结 assetId/assetVersionId
  -> 预检模型能力和外发策略
  -> 仅发送必要片段或媒体内容
```

资源重命名不改变 `assetId`；历史 Run 保留当时的显示名和版本。选择资源不会立即向第三方发送二进制内容。

## 11. 上下文账本

上下文面板统一按以下分类统计：

```text
系统指令
用户当前问题
最近对话
历史摘要
画布输入
文件片段
网页证据
工具结果
Agent 计划摘要
预留输出空间
```

每一项应尽量记录：

- `contextItemId`、来源类型和来源 ID。
- 进入上下文的时间和原因。
- Token 估算值和实际值（若供应商返回）。
- 是否被用户锁定。
- 是否被压缩、移除或替换。

必须区分估算值和供应商实际 usage。没有精确计数器时显示“估算”，不能伪造精确数字。

### 11.1 自动压缩策略

接近模型上下文上限时按以下顺序处理：

1. 删除重复搜索结果和未使用的工具输出。
2. 只保留被引用的网页片段。
3. 对较早对话生成摘要。
4. 保留系统安全规则、用户锁定内容和当前任务。
5. 仍不足时暂停并要求用户移除文件或提高 Token/上下文上限；不得以本地金额预算阻塞功能。

压缩前后都要发送 `context.updated` 事件，并允许用户查看哪些内容被压缩。

## 12. 事件协议和动作可视化

所有 Agent 入口共用以下事件命名：

```text
run.created
run.preflight.completed
plan.summary.created
step.started
step.progress
tool.requested
tool.started
tool.completed
web.query.created
web.source.consulted
web.page.opened
file.retrieved
context.updated
approval.required
artifact.created
run.paused
run.resumed
run.completed
run.failed
run.cancelled
```

事件必须带：

- `runId`、`sequence`、`timestamp`。
- `stepId`、事件类型和状态。
- 面向用户的短摘要。
- 可选的 source、file、artifact、usage 和 error 引用。
- 脱敏后的输入/输出摘要。

前端只展示用户可理解的动作摘要，不展示完整隐藏思维链。例如：

```text
✓ 解析任务
✓ 生成 2 个搜索词
↻ 搜索：2026 年相关行业数据
↻ 打开 3 个网页
○ 比较来源差异
○ 整理证据
○ 生成最终回答
```

## 13. Provider Adapter 和能力矩阵

Provider Adapter 统一表达：

- 文本和多模态消息。
- Tool Calling。
- Structured Output。
- Streaming。
- Token/供应商 `usage`（费用字段仅透传，不用于本地收费）。
- 超时、取消和错误。
- 模型能力。

每个模型至少维护以下能力：

```text
toolCalling
structuredOutput
streaming
vision
audioInput
videoInput
nativeWebSearch
fileSearch
reasoning
contextWindow
backgroundRun
imageGeneration
audioGeneration
videoGeneration
```

OpenAI、Anthropic、xAI/Grok、DeepSeek、智谱 GLM/ZLM 可以通过统一 Adapter 调用，但不代表能力完全相同。能力未知或不支持时，必须在真实 Provider 请求前失败，例如：

```text
UNSUPPORTED_TOOL_CALLING
UNSUPPORTED_WEB_SEARCH
UNSUPPORTED_FILE_INPUT
UNSUPPORTED_MEDIA_ROLE
CONTEXT_LIMIT_EXCEEDED
PROVIDER_CAPABILITY_UNKNOWN
```

不能静默丢弃文件、图片、工具、结构化输出或引用角色。

建议 Provider 接入顺序：OpenAI、Anthropic、DeepSeek、xAI/Grok、智谱 GLM/ZLM。

## 14. 公共数据模型候选

建议新增或扩展以下领域对象；具体 Prisma 命名在实现前评审：

| 对象                   | 作用                                             |
| ---------------------- | ------------------------------------------------ |
| AgentDefinition        | Agent 基本定义                                   |
| AgentDefinitionVersion | Prompt、工具和策略版本                           |
| AgentSession           | 独立页面多轮会话                                 |
| AgentRun               | 一次不可变执行                                   |
| AgentStep              | 可观测步骤                                       |
| AgentEvent             | 可回放事件日志                                   |
| AgentCheckpoint        | 暂停/恢复位置                                    |
| AgentToolCall          | 工具参数、结果和幂等信息                         |
| NetworkPolicySnapshot  | 运行时联网权限快照                               |
| WebSearchQuery         | 搜索词和结果摘要                                 |
| WebSource              | 网页来源和内容 Hash                              |
| FileReference          | 文件/资产/分块引用                               |
| ContextItem            | 实际进入上下文的内容                             |
| ContextUsage           | Token、供应商 usage 和压缩统计（不参与本地收费） |
| AgentApproval          | 人工审批记录                                     |
| ArtifactProvenance     | 产物来源清单                                     |

现有 `Run` 可以继续服务画布媒体任务，但 Agent Run 建议有清晰的类型或关联字段，避免把多轮 Session 和一次媒体 ProviderJob 混在一个语义对象里。

Run 快照至少冻结：

```text
agentDefinitionVersion
modelAlias
providerId
credentialId / credentialVersion
networkPolicy
toolAllowlist
fileReferences
assetReferences
canvasInputSnapshot
budgetLimits
stepLimits
timeout
locale
```

凭据只保存引用和版本号，不保存明文 Key。

## 15. 公共 API 与 SSE

建议的公共接口：

```text
GET    /agent/definitions
GET    /agent/definitions/:definitionId
POST   /agent/runs
GET    /agent/runs/:runId
GET    /agent/runs/:runId/events
GET    /agent/runs/:runId/sources
GET    /agent/runs/:runId/context
GET    /agent/runs/:runId/usage
POST   /agent/runs/:runId/preflight
POST   /agent/runs/:runId/cancel
POST   /agent/runs/:runId/pause
POST   /agent/runs/:runId/resume
POST   /agent/runs/:runId/approve
POST   /agent/runs/:runId/fork
```

SSE 必须支持：

- 单调递增事件序号。
- `Last-Event-ID` 断线续传。
- 已完成事件回放。
- 重连后不重复追加消息或 Artifact。
- 页面刷新后恢复当前 Run 状态。

## 16. 安全、隐私和运行资源限制

### 16.1 网络安全

必须防护：

- SSRF、DNS Rebinding、私有 IP 和云元数据地址。
- 恶意重定向、超大响应、压缩炸弹和长时间连接。
- 非 HTTP 协议、危险 MIME 和脚本执行。
- 网页、文件、图片 OCR 和节点输出中的 Prompt Injection。

### 16.2 外发提示

联网或文件引用可能向第三方发送数据时，预检应明确说明：

```text
搜索词可能发送给搜索服务。
明确选择的文件片段可能发送给模型供应商。
未选择的文件不会自动发送。
```

项目级策略建议支持：禁止文件外发、仅允许脱敏片段、仅允许选定文件、允许全部文件。

### 16.3 运行资源限制和限流

每个 Run 应可限制：

- 最大步骤数。
- 最大搜索次数和打开页面数。
- 最大 Token、运行时间、上下文、输入大小和并发；供应商费用字段仅记录，不作为本地收费或授权依据。
- 最大并发工具数。
- 单用户、单项目和全局并发。

运行资源达到阈值时，Run 必须暂停或失败并给出可诊断原因；该限制用于保护服务稳定性，不涉及本地收费，供应商计费仍由上游处理。

### 16.4 幂等

```text
工具调用：runId + stepId + toolInputHash
事件：runId + sequence
网页来源：canonicalUrl + contentHash
媒体任务：沿用现有 ProviderJob 幂等键
```

## 17. 与现有仓库模块的映射

| 现有模块                  | 公共 Agent 计划中的职责                                 |
| ------------------------- | ------------------------------------------------------- |
| `packages/domain`         | Agent、Tool、Event、Source、Context、Capability Schema  |
| `packages/providers`      | LLM Provider Adapter、搜索 Adapter、能力矩阵            |
| `apps/worker`             | LangGraph Runtime、Agent 队列、Checkpoint、工具执行     |
| `apps/api`                | Definition、Session、Run、Source、Context、Approval API |
| `apps/web`                | 公共事件模型、运行详情、来源/上下文组件                 |
| `packages/observability`  | Run、Step、Tool、Token、供应商 usage 和失败追踪         |
| `prisma/schema.prisma`    | Agent 相关持久化模型和索引                              |
| 现有 `Asset/AssetVersion` | 文件、媒体产物和来源版本                                |
| 现有 `ProviderJob`        | 图片、音频、视频等异步媒体任务                          |
| 现有 `Run` 快照           | 画布执行输入和模型/凭据冻结，可扩展关联 Agent Run       |

实现时不得重复建设资产归档、凭据存储、媒体任务恢复和项目权限。

## 18. 公共实施阶段

### C0：契约冻结

- [ ] 确定 AgentDefinition、AgentRun、AgentStep、AgentEvent Schema。
- [ ] 确定 NetworkPolicy 四种模式和默认值。
- [ ] 确定 Tool Registry、权限组和错误码。
- [ ] 确定 Source、Citation、FileReference、ContextItem 表示。
- [ ] 建立模型能力矩阵字段。
- [ ] 评测并选定首个 WebSearchAdapter。

### C1：Runtime 和事件

- [ ] LangGraph 状态图和 BullMQ Agent 队列。
- [ ] Run 状态机、检查点、暂停/恢复/取消。
- [ ] Tool Schema、权限、运行资源限制和幂等校验。
- [ ] SSE 事件流、序号和断线重连。
- [ ] 公共运行详情数据结构。

### C2：只读联网和来源

- [ ] `web.search`、`web.open`、`web.findInPage`。
- [ ] SSRF、域名策略、响应限制和内容 Hash。
- [ ] 搜索记录、来源存储、引用生成和去重。
- [ ] 页面正文抽取和失败诊断。

### C3：文件、资源和上下文

- [ ] 文件解析、分块、索引和权限过滤。
- [ ] `@`资源引用和版本冻结。
- [ ] 上下文账本、估算/供应商实际 Token `usage`（仅观察，不做本地收费）。
- [ ] 对话摘要、证据去重和上下文压缩。

### C4：多供应商和生产加固

- [ ] OpenAI、Anthropic、DeepSeek、xAI/Grok、GLM/ZLM Adapter。
- [ ] 能力预检、错误归一化、Fallback 和限流。
- [ ] 审计、供应商 usage/可选费用字段、告警、数据保留和灰度开关。

### 18.1 推荐启动顺序

两份入口文档不按“先完整实现一份、再完整实现另一份”推进，而是先完成公共底座的最小闭环，再以可验证的垂直切片逐步接入两个入口。推荐顺序如下：

| 顺序 | 实施范围                                               | 主要目标                                                                                                                    | 阶段性验收                                                                          |
| ---- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1    | `C0-C2` 公共底座                                       | 冻结 Agent/Tool/Run/Event 契约；完成 LangGraph + BullMQ Runtime、SSE、`offline`/`search_read`、只读联网、来源记录和安全预检 | 在没有任何产品入口专属逻辑的情况下，完成一次可暂停、可恢复、可回放的只读联网 Run    |
| 2    | [独立页面 Agent](TODO-AGENT-STANDALONE.md) 的 `S0-S2`  | 先验证 Session、多轮聊天、联网开关、当前动作时间线、搜索记录、来源引用、刷新恢复和断线重连                                  | 用户可以在浏览器独立完成一次“开启联网并查看搜索与引用”的完整流程                    |
| 3    | [画布节点 Agent](TODO-AGENT-CANVAS-NODE.md) 的 `N0-N3` | 复用已验证的 Runtime，将 Agent 接入画布节点、显式连线输入、`@`资源快照和 Artifact 回写                                      | Agent 只能使用明确授权的上游输入，并能把结果作为节点输出连接到下游                  |
| 4    | `C3` 与两个入口的文件/上下文能力                       | 完成文件解析、权限过滤、`@`引用、页码/片段定位、上下文账本和压缩；独立页面对应 `S3`，画布对应 `N2-N3` 的文件和产物细节      | 回答和产物可以追溯到具体文件版本、网页片段和上下文用量，且不会外发未选择的文件      |
| 5    | `C4`、独立页面 `S4-S5`、画布 `N4`                      | 扩展多 Provider、Artifact 互通、深度研究、隔离浏览器和高风险动作审批                                                        | 高级能力在既有权限、运行资源限制、审计和幂等机制上灰度开放，不改变已完成 Run 的语义 |

独立页面排在画布节点之前，是因为它能在没有 DAG、节点端口、输入快照和媒体回写等额外复杂度的情况下，先验证 Agent Runtime、联网策略、多 Provider、动作可视化、来源和上下文等公共能力。画布节点随后主要增加“画布输入适配”和“产物输出适配”，不重复建设 Agent 核心逻辑。

第 3 步不要求等待独立页面的全部高级功能完成；独立页面完成 `S0-S2` 后即可开始画布 `N0-N1`。画布 `N2-N3` 中依赖文件、`@`资源和上下文的部分，应在公共 `C3` 契约冻结后推进。首个可用 Provider 可以先支持一个经过验证的供应商，多 Provider 扩展放在 `C4`，不应阻塞前两个入口的 Runtime 验收。

## 19. 公共测试和验收

必须覆盖：

- 联网关闭时没有外部网络请求。
- 允许域名、禁止域名和私有地址校验。
- 恶意网页和文件 Prompt Injection 不会获得工具权限。
- 搜索失败、页面失败、重定向和超时可诊断。
- 搜索记录和最终引用准确区分。
- 文件权限不会跨项目泄漏。
- 文件、来源和上下文引用可定位到版本/页码/片段。
- 上下文超限可压缩、暂停或失败。
- SSE 断线、Worker 重启和事件重放不产生重复副作用。
- Provider 不支持能力时不会发起不符合契约的真实请求。
- 媒体 Artifact 继续进入现有 Asset/AssetVersion 链路。

### 公共完成定义

只有同时满足以下条件，公共底座才可标记完成：

1. 两个入口使用同一套 Agent、Tool、Event、Source、Context 协议。
2. 联网策略在服务端强制生效，并能审计每次外部访问。
3. 搜索记录、来源引用、文件引用和上下文用量可回放。
4. Run 能暂停、恢复、取消、重试和从检查点继续。
5. 多供应商能力差异不会导致输入静默丢失。
6. 所有媒体产物仍可追溯到 ProviderJob、Run 和 AssetVersion。

## 20. 待用户确认的公共决策

- [ ] 首个搜索服务选择 Tavily、Exa、Brave、Bing 还是自建 SearXNG。
- [x] 搜索服务费用由上游搜索 Provider 计算和结算；本项目当前不向用户收费、不扣减项目/用户额度，仅记录可用的 `usage`/状态字段。
- [ ] 默认联网模式是 `offline` 还是独立页面默认 `search_read`。
- [ ] 是否允许用户在项目级禁止所有文件外发。
- [ ] 文件和网页来源的默认保留时长。
- [ ] Agent Run 是否单独建表，还是扩展现有 `Run`。
- [x] 第一版优先展示供应商返回的 Token `usage`；未返回时展示估算并明确标注，不涉及本地收费。
- [ ] 浏览器操作模式何时进入开发范围。

## 21. 参考资料

实施时需重新核对官方接口版本和供应商契约：

- [OpenAI Agents SDK](https://developers.openai.com/api/docs/guides/agents)
- [OpenAI Web search](https://developers.openai.com/api/docs/guides/tools-web-search)
- [OpenAI File search](https://developers.openai.com/api/docs/guides/tools-file-search)
- [OpenAI Streaming responses](https://developers.openai.com/api/docs/guides/streaming-responses)
- [OpenAI Token counting](https://developers.openai.com/api/docs/guides/token-counting)
- [OpenAI Compaction](https://developers.openai.com/api/docs/guides/compaction)
- [OpenAI Background mode](https://developers.openai.com/api/docs/guides/background)

以上资料只作为 Provider 能力参考，项目内部契约以本文件和两份入口文档的评审结果为准。
