# 画布节点 Agent 计划

版本：0.1
状态：方案待评审，未开始实现
优先级：P0/P1，PC Web 工作台优先

## 1. 依赖和文档边界

本文件只描述画布内 Agent 节点的产品流程、画布输入、权限、输出和验收。公共 Agent、联网、来源、上下文、事件、Provider 和安全契约统一引用 [Agent 公共底座与联网能力计划](TODO-AGENT-COMMON.md)。

独立页面的多轮 Session、聊天布局、页面级联网开关和研究体验见 [独立页面 Agent 计划](TODO-AGENT-STANDALONE.md)。

## 2. 目标

用户可以在画布中添加一个 Agent 节点，用自然语言描述任务；Agent 读取明确连接的上游节点、已确认的 `@`资源和允许的联网来源，自动调用白名单工具，最终产出文本、图片、音频、视频或其他 Artifact，并把结果作为该节点的输出继续连接到下游。

典型任务：

```text
把上游角色图和背景图合成一张海报，并参考最新品牌规范。
```

执行含义：

1. 读取 Agent 节点明确连接的角色图和背景图。
2. 如节点开启联网，搜索允许域名中的品牌规范。
3. 调用已有图片生成或处理能力。
4. 通过 ProviderJob 生成和归档图片。
5. 将 Asset/AssetVersion 和来源清单写入 Agent 节点结果。

## 3. 非目标

首版不允许 Agent：

- 根据坐标、最近节点、创建时间或模糊名称猜测输入。
- 自动扫描整个画布、整个项目或用户电脑文件。
- 任意创建、删除、移动或改连线。
- 覆盖已有节点或资产。
- 自动执行系统命令、任意代码或真实浏览器点击。
- 因 Provider 不支持某输入而静默丢弃该输入。

修改画布结构、发布内容、删除资产和覆盖已有节点属于后续高风险工具，必须有明确目标和人工审批。

## 4. 节点定位和配置

### 4.1 节点类型

建议新增逻辑类型 `agent`，但保留节点最终 Artifact 的媒体类型，以便下游节点按现有端口协议连接。节点本身不应因为 Agent 计划不同而重复实现图片、音频和视频 Provider。

### 4.2 节点配置字段

建议配置结构如下，具体字段名在实现前以 `packages/domain` Schema 评审结果为准：

```json
{
  "agentDefinitionId": "agent-definition-uuid",
  "agentDefinitionVersion": 3,
  "promptDocument": {
    "blocks": []
  },
  "modelAlias": "default-reasoning-model",
  "networkPolicy": {
    "mode": "offline",
    "allowedDomains": [],
    "blockedDomains": [],
    "maxSearchQueries": 0
  },
  "toolAllowlist": ["canvas.read", "asset.read", "artifact.create", "media.generate"],
  "outputMode": "artifact",
  "maxSteps": 12,
  "timeoutSeconds": 300,
  "budget": {
    "maxTokens": 24000,
    "maxCost": null
  }
}
```

### 4.3 运行前冻结

点击节点运行时必须生成不可变快照，至少冻结：

- AgentDefinition 版本。
- 提示词文档和 `@`引用顺序。
- 明确连接的 CanvasNode/CanvasEdge 输入。
- Asset/AssetVersion 身份。
- 模型别名、Provider、凭据 ID/版本。
- NetworkPolicy 和工具白名单。
- 最大步骤、超时和预算。
- 目标输出端口及节点版本。

节点配置在运行期间发生变化，不修改当前 Run；应创建新 Run 或 Fork。

## 5. 输入契约

### 5.1 显式连线优先

画布边的 `sourceHandle`、`targetHandle` 和 `sortOrder` 是 Agent 输入的权威来源。每个输入必须保留：

- 来源节点 ID。
- 来源端口角色。
- 资产 ID 和版本。
- 连接顺序。
- 媒体类型和元数据。

### 5.2 `@`资源引用

提示词中的 `@`引用属于内联输入，与画布连线互补：

- 连线表达节点间的结构化输入。
- `@`表达提示词中的具体资源位置和可选语义角色。

用户必须选择并确认资源后才能保存引用。运行时按 `assetId + assetVersionId` 读取，不按显示名称查询。

### 5.3 输入冲突

如果同一语义角色同时来自连线和 `@`引用，必须在运行前显示来源和优先级：

- 默认保留两者并按明确顺序传递。
- 需要单值的角色出现多个输入时，在提交前阻断。
- 不允许自动选择“最近的”或“最新的”一个。

### 5.4 能力预检

提交前根据节点媒体类型、输入角色和模型能力矩阵检查：

- Tool Calling。
- Structured Output。
- 图片/音频/视频输入。
- 参考图、首尾帧、音轨、遮罩等角色。
- 最大输入数量和上下文窗口。

不支持时显示具体角色、模型、Provider 和解决建议，不创建付费 ProviderJob。

## 6. 画布联网策略

节点设置中提供联网模式，但使用公共底座中的四态策略：

| 节点设置   | 行为                                                |
| ---------- | --------------------------------------------------- |
| 关闭联网   | 只能使用连线、`@`资源和已上传文件                   |
| 搜索与读取 | 可以调用 `web.search`、`web.open`、`web.findInPage` |
| 深度研究   | 允许更多搜索和页面，但受节点预算限制                |
| 浏览器操作 | 首版隐藏或禁用；后续单独审批                        |

画布 Agent 默认 `offline`。开启联网时，节点面板必须显示域名过滤、最大搜索次数、外发文件策略和预算。

联网策略在 Run Snapshot 中冻结；当前运行中不能通过修改节点开关绕过服务端策略。

## 7. 节点执行流程

```text
用户添加 Agent 节点
        ↓
填写任务描述、选择 Agent 和模型
        ↓
连接上游节点或确认 @资源
        ↓
选择联网模式和工具权限
        ↓
预检模型能力、输入和预算
        ↓
创建不可变 Run Snapshot
        ↓
BullMQ 投递 Agent Worker
        ↓
LangGraph 规划并调用工具
        ↓
读取节点/资产/网页/文件
        ↓
调用现有 ProviderJob 生成媒体或 Artifact
        ↓
归档 Asset/AssetVersion 和来源
        ↓
更新 Agent 节点输出和运行状态
```

### 7.1 典型步骤

```text
解析任务
  -> 加载画布输入
  -> 检查联网策略
  -> 生成计划摘要
  -> 搜索或读取来源（若授权）
  -> 调用节点/资产/媒体工具
  -> 校验产物
  -> 保存 Artifact/Asset
  -> 生成来源和上下文报告
```

Agent 只能输出计划摘要和工具状态，不向用户展示完整隐藏思维链。

## 8. 画布 UI 计划

### 8.1 节点卡片

节点卡片至少显示：

- Agent 名称和版本。
- 当前模型和联网状态。
- 输入数量和媒体类型。
- 运行状态、耗时和错误。
- 最近产物缩略图或文本摘要。
- 是否等待审批。

### 8.2 配置面板

配置面板分为：

1. 任务描述：共用 `@`资源提及编辑器。
2. 输入：列出显式连接、端口角色、顺序和版本。
3. Agent/模型：AgentDefinition、模型别名和能力提示。
4. 联网：模式、域名过滤、搜索次数、文件外发策略。
5. 工具权限：只读、媒体生成、写入和高风险操作分组。
6. 预算：步数、Token、金额、超时和并发。
7. 输出：Artifact 类型、下游端口和保存策略。

### 8.3 当前动作显示

节点运行详情复用公共事件组件，至少展示：

```text
✓ 已读取 2 个上游输入
✓ 已生成执行计划
↻ 正在搜索品牌规范
↻ 正在生成图片任务
○ 等待 Provider 完成
○ 写回节点输出
```

点击某一步可以查看脱敏输入摘要、耗时、来源、Token 和错误；不展示密钥或完整文件原文。

### 8.4 来源和上下文

运行详情中增加三个标签页：

- 来源：最终引用、已检索未引用、失败和被阻止来源。
- 输入：上游节点、`@`资源、文件和版本。
- 上下文：分类 Token、估算/实际 usage、压缩记录。

### 8.5 输出操作

首版支持：

- 保存文本 Artifact。
- 保存图片、音频、视频 Asset。
- 将产物作为 Agent 节点输出连接下游。
- 查看来源和产物溯源。
- 重试失败步骤或从检查点继续。

后续支持：

- 明确选择目标后创建新节点。
- 发送结果到已有空节点。
- 发布或批量导出，但均需人工确认。

## 9. API 计划

公共接口见 [TODO-AGENT-COMMON.md](TODO-AGENT-COMMON.md)。画布侧增加以下参数或专用接口：

```text
POST /v1/projects/:projectId/canvases/:canvasId/agent-runs
GET  /v1/projects/:projectId/canvases/:canvasId/agent-runs/:runId
POST /v1/projects/:projectId/canvases/:canvasId/agent-runs/:runId/retry-step
POST /v1/projects/:projectId/canvases/:canvasId/agent-runs/:runId/apply-output
```

创建请求至少包含：

```json
{
  "canvasNodeId": "agent-node-id",
  "agentDefinitionId": "...",
  "agentDefinitionVersion": 3,
  "promptDocument": {},
  "connectedInputSnapshot": [],
  "resourceReferences": [],
  "modelAlias": "...",
  "networkPolicy": {},
  "toolAllowlist": [],
  "budget": {}
}
```

服务端必须重新读取并校验节点、边、资产权限和版本，不能信任浏览器传来的完整输入快照。

## 10. 数据和现有模块映射

- `CanvasNode.data`：保存 Agent 配置的可编辑版本或引用。
- `CanvasEdge`：保存显式输入角色和稳定顺序。
- 现有 `Run.snapshot`：保存本次画布输入、模型、凭据和 Agent 策略快照。
- `RunInput`：保存上游节点和资源输入的冻结身份。
- `Asset/AssetVersion`：保存 Agent 生成的媒体产物。
- `ProviderJob`：执行图片、音频、视频等异步供应商任务。
- `apps/worker`：新增 Agent Worker 入口和步骤恢复逻辑。
- `apps/web/src/workspace`：新增节点面板、运行详情和事件时间线。

如果新增独立 Agent Run 表，应通过 `canvasNodeId` 和 `sourceRunId` 关联现有 Run，避免一条运行同时承担聊天和画布执行两种生命周期。

## 11. 实施阶段

### N0：节点契约和 Mock

- [ ] 定义 Agent 节点数据 Schema、输入角色和输出端口。
- [ ] 支持固定 AgentDefinition 版本和 Mock Runtime。
- [ ] 保存显式连线、`@`引用和模型能力预检结果。
- [ ] 确定默认联网模式为 `offline`。

验收：刷新、导出、重新导入后，节点配置和输入顺序一致。

### N1：画布 Agent Runtime

- [ ] BullMQ Agent Job 和 LangGraph 状态图。
- [ ] Run Snapshot、检查点、暂停、恢复、取消和重试。
- [ ] 复用公共 SSE 事件和运行详情组件。
- [ ] 复用 `asset.read`、`canvas.read`、`artifact.create`、`media.generate`。

验收：Worker 重启后可从最新检查点继续，重复事件不会重复创建资产。

### N2：只读联网和文件

- [ ] 节点级 `search_read` 和 `deep_research`。
- [ ] 域名策略、来源清单和最终引用。
- [ ] 明确选择的文件/资产片段引用。
- [ ] 上下文账本和压缩。

验收：联网关闭时不会产生外部请求；联网开启时来源和引用可回放。

### N3：媒体产出和下游连接

- [ ] Agent 根据计划调用现有媒体工具。
- [ ] 产物进入 Asset/AssetVersion/ProviderJob。
- [ ] 输出端口按媒体类型和版本连接下游。
- [ ] 失败步骤单独重试，避免重新扣费。

验收：文字、图片、音频、视频至少各有一个 Mock E2E 闭环。

### N4：高风险写入能力

- [ ] 创建节点、填充空节点和发布产物工具。
- [ ] 明确目标选择和人工审批。
- [ ] 冲突时拒绝覆盖，保留已创建 Artifact。

默认不进入首版交付，需单独评审。

## 12. 测试矩阵

### 协议和 Worker

- [ ] 无上游输入、单输入、多输入和重复输入。
- [ ] 连接顺序在保存、重试、恢复和导入导出后保持一致。
- [ ] `@`资源引用删除、替换、重命名和版本冻结。
- [ ] 模型不支持 Tool Calling、媒体角色或结构化输出时提前失败。
- [ ] 搜索服务失败、网页读取失败、超时和域名阻止。
- [ ] Worker 重启、SSE 重放和重复队列消息不会重复扣费。

### Web/E2E

- [ ] 添加 Agent 节点、连接输入、编辑任务和运行。
- [ ] 联网开关和域名策略在页面与服务端一致。
- [ ] 动作时间线、搜索记录、来源、上下文和文件引用可见。
- [ ] 取消、暂停、恢复和失败步骤重试。
- [ ] 生成 Asset 后节点输出刷新，下游可继续运行。
- [ ] 运行详情不出现 API Key、Bearer token 或完整敏感文件内容。

## 13. 发布前冒烟场景

```text
文字节点 + 图片节点
      ↓
Agent 节点（联网：搜索与读取）
      ↓
读取明确上游输入
      ↓
搜索一个允许域名
      ↓
调用图片生成 ProviderJob
      ↓
归档 Asset/AssetVersion
      ↓
显示动作、来源、上下文和产物
      ↓
输出连接到下游节点
```

必须验证：

1. 画布只读取明确输入。
2. 搜索词和来源可见。
3. 回答/产物包含可追溯来源。
4. ProviderJob 和 Asset 只创建一次。
5. 刷新页面后运行状态和输出仍可恢复。

## 14. 风险与缓解

| 风险                 | 缓解                                         |
| -------------------- | -------------------------------------------- |
| Agent 读取了错误节点 | 只允许显式边、显式 `@`引用和快照             |
| Agent 无限规划       | 最大步骤、时间、Token 和金额预算             |
| 网页内容诱导越权     | 页面全部视为不可信数据，工具权限由服务端决定 |
| 重试导致重复媒体任务 | `runId + stepId + toolInputHash` 幂等        |
| 模型丢弃多媒体输入   | 能力预检，失败不创建付费请求                 |
| 写回覆盖用户数据     | 首版只输出 Artifact；写入必须指定目标并审批  |

## 15. 完成定义

画布节点 Agent 只有在以下条件全部满足后才可标记完成：

1. 能保存和恢复 AgentDefinition、任务描述、连线输入和 `@`资源引用。
2. 能根据自然语言调用白名单工具并显示当前动作。
3. 联网策略由服务端强制执行，搜索和来源可审计。
4. 文件、网页和上游资产均按版本冻结并能追溯。
5. 文字和媒体 Artifact 能进入现有归档链路。
6. Worker 重启、SSE 断线、失败重试和重复事件不会破坏画布或重复扣费。
7. 未授权的画布写入、删除和覆盖都会被阻断。

## 16. 待用户确认

- [ ] Agent 节点是否默认只输出 Artifact，还是允许首版直接创建媒体节点。
- [ ] 画布节点是否允许 `deep_research`，还是只开放 `search_read`。
- [ ] 节点级最大搜索次数、打开页面数和预算默认值。
- [ ] Agent 产物是否自动显示为节点缩略图。
- [ ] 失败步骤重试是否允许更换模型。
- [ ] 将结果写入空节点的功能排在何时。
