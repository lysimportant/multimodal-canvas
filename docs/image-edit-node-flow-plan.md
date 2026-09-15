# 图片资源节点“修改图片”流程开发实现步骤

## 1. 目标与范围

当图片节点已经回显上传或生成的图片时，用户选择“修改图片”应进入图生图流程：用户填写要修改的内容，系统创建一个新的图片生成节点，将原图作为输入连接过去，自动选中新节点并打开快速编辑器。原图片节点继续保留原位置、尺寸、节点 ID 和回显内容。

本任务面向 PC Web 画布，包含前端交互、画布数据、运行快照、Provider 能力校验和测试方案。移动端专用布局、批量多图编辑、局部蒙版编辑和 Provider 未声明的扩展参数列为后置事项。

## 2. 不可违反的边界

- 原图片资源节点是来源节点，不能被复用为编辑节点，不能覆盖其 `assetId`、`contentUrl`、`resultAsset` 或 `manualOutput`。
- 新编辑节点必须使用全新的节点 ID，并通过显式边连接来源节点；不得用隐式的“文本创建”入口代替图片输入。
- 运行前冻结来源资产的 `assetId + version`。来源节点后续产生新版本时，已经创建的编辑运行仍使用冻结版本。
- 新节点的位置应在来源节点右侧的可用画布区域；发生碰撞时按现有画布定位工具继续向右或向下寻找空位，不能改变来源节点尺寸。
- Provider 未确认支持的模型、字段或图片数量必须在 POST 前失败，并向用户说明原因；不能静默退回文生图。

## 3. 用户流程与状态

```text
图片节点（已有回显）
  -> 点击“修改图片”
  -> 新建图片编辑节点 + 来源图片输入边
  -> 选中新节点并打开 NodeQuickEditor
  -> 提示“想用这张图修改什么？”
  -> 用户填写修改提示词并运行
  -> 新节点显示结果，原节点保持不变
```

建议增加可追踪的编辑意图状态：`idle`、`creating`、`editing`、`running`、`succeeded`、`failed`。创建失败时不留下半成品节点和边；运行失败时保留原图与新节点，允许修改提示词后重试。

## 4. 数据模型设计

1. 在 `AssetFlowNode.data` 增加明确的图片编辑语义字段，例如 `imageEditSource?: { assetId: string; version: number; sourceNodeId: string }`，或等价的版本化来源引用。字段必须通过 `packages/domain/src/index.ts` 的 schema 校验并兼容旧画布缺省值。
2. 新节点仍是 `mediaType: 'image'`、`mode: 'generate'`，提示词保存在 `promptDocument`，并保留旧 `prompt` 作为兼容回退。
3. 新边的目标 handle 使用图片输入角色。优先采用已存在的 `content` 或 `referenceImage` 语义，但在领域层固定一种编辑角色，避免由连接顺序猜测；若新增角色，必须同步 `portRoles`、目标端口、连接校验、运行快照和导入导出。
4. `toCanvasDocument`、导入导出和历史记录必须包含新节点及边；运行快照必须包含不可变的来源节点和 `assetId/version`，不读取运行时变化后的最新资源。

## 5. 前端实施步骤

### 5.1 来源节点操作入口

- 在 `apps/web/src/workspace/AssetNode.tsx` 的已有资源操作区域增加“修改图片”按钮，仅当节点为图片且存在可用预览资产时显示。
- 对来源节点和已有生成结果统一提供入口，但按钮文案和可访问名称明确为“修改图片”；无图片内容时继续使用普通“生成”流程。
- 事件回调沿 `WorkflowCanvas.tsx` 传到 `App.tsx`，携带 `sourceNodeId`，不要把来源节点转换成可编辑节点。

### 5.2 创建、连线和自动打开

- 在 `App.tsx` 增加 `handleCreateImageEditNode(sourceNodeId)`，复用 `createGenerateNode('image', position)`、`appendNodesAndSelect` 和现有连接校验。
- 从 `nodesRef` 读取来源节点，确认图片预览存在并取得当前资产版本；构造来源到新节点的单条输入边，调用 `buildConnectedGenerateNodeConnection` 或同等显式构造函数。
- 以来源节点右侧为首选位置，使用 `getNewNodeDimensions('image')` 和碰撞检测计算可用位置；新节点默认尺寸不得由提示词或回显内容撑大。
- 在同一个历史记录事务中追加节点和边，然后选中新节点，设置画布 dirty 状态，并让 `WorkflowCanvas` 的 `quickEditorNode` 打开该节点的 `NodeQuickEditor`。
- 失败时回滚本次节点/边追加并显示可操作错误；成功提示应说明“已创建图片修改节点”。

### 5.3 快速编辑器

- 在 `apps/web/src/workspace/NodeQuickEditor.tsx` 对图片编辑节点显示专用标题和占位提示：“想用这张图修改什么？例如：换成夜景、去掉背景”。
- 保持图片模型、尺寸、清晰度等已有参数；编辑提示词是必填运行条件，空值时禁止提交并保留焦点。
- 编辑器中可显示来源图缩略图和固定版本标识，但只读，不能修改来源节点内容。关闭编辑器不删除新节点。
- 运行按钮沿现有 `onRun` 入口，提交前检查来源资产仍可读取且版本存在；版本不可用时给出明确错误并停止请求。

## 6. Provider 与运行链路

`packages/providers/src/index.ts` 已有基础映射：无图片输入走 `/images/generations`，带一张图片输入走 `/images/edits`，图片 `content/referenceImage` 会映射到编辑接口的 `image` 字段。实现时应：

1. 将新编辑角色映射到 `imageEditSourceRoles`，并保持最多一张图片的现有 cardinality 校验；多图能力需单独取得 Provider 合同后再开放。
2. 在模型目录/能力矩阵中声明哪些模型支持 image edit、允许的 mime type、尺寸和参数字段。能力未知时在 API 创建 Run 前返回稳定错误码，不生成 Provider 请求。
3. 沿用现有 Worker 资产引用解析器按 `assetId/version` 读取不可变内容，禁止用未版本化的最新 URL。记录来源节点 ID、来源资产版本、目标运行 ID，便于重试和审计。
4. 保持结果写入新节点的 `resultAsset`；失败不改变来源节点的成功状态，也不替换来源资产。

## 7. 兼容与迁移

- 旧画布没有编辑字段时按普通图片生成节点处理；不自动推断历史节点曾经的编辑来源。
- 导入数据遇到未知编辑字段或缺失资产版本时，阻止运行并给出修复提示，不丢弃节点或边。
- 撤销/重做、复制节点和画布导出必须保持来源边和版本引用的一致性。

## 8. 测试与验收

### 单元与组件测试

- 领域 schema：编辑来源字段、版本必填、重复节点 ID、非法输入角色和旧画布兼容。
- 连接工具：图片来源只能连接到图片编辑输入角色；循环、重复边和多图超限被拒绝。
- `AssetNode`：有回显显示“修改图片”，无回显不显示；点击事件携带正确来源节点 ID。
- `WorkflowCanvas`/`App`：创建后新增节点和边、自动选中并打开 `NodeQuickEditor`，来源节点数据完全不变；碰撞定位和撤销/重做正常。
- `NodeQuickEditor`：专用占位文案、空提示词阻止运行、来源缩略图只读。
- Provider：带图片输入请求 `/images/edits`，无图片输入请求 `/images/generations`，未支持模型在请求前失败，来源版本读取失败不会发起请求。

### Playwright 冒烟

在 PC Web 工作台创建或上传图片，点击“修改图片”，确认新节点出现在右侧、原节点仍可见且尺寸未变；确认编辑器自动打开，填写修改提示词并运行。使用可控测试 Provider 验证结果只写入新节点，并检查浏览器控制台无错误。至少覆盖桌面宽屏和方形画布视口。

### 验收标准

- 用户无需手动拖线即可从回显图片进入修改流程。
- 新节点拥有独立 ID、独立结果和显式来源边；原节点位置、尺寸、回显和资产版本不被改变。
- 编辑器明确询问修改意图，生成请求根据能力矩阵选择正确接口；不支持情况有可理解的错误。
- 导入导出、运行快照、撤销重做和失败重试均保留上述不变式。

## 9. 风险与后置事项

- 不同 Provider 对 `/images/edits` 的字段、图片格式和 mask 支持不一致，必须以实时目录和正式合同为准，不能用 Mock 结果宣称真实能力。
- 若未来支持多参考图、局部重绘或连续编辑，应扩展为版本链/派生关系模型，并重新评估配额、清理和 UI 信息密度。
- 真实 Provider 验收应记录精确模型 ID、请求/任务 ID、输入版本和输出资产；未知费用或合同字段保持未知，不通过猜测补齐。

## 10. 本轮落地记录

实现状态：本文档第 1 至 8 节已在仓库内落地，并已在真实栈上用真实凭据完成一次端到端验收（见下）。

### 已实现

- 领域层：`portRoles` 新增 `imageEdit` 角色，`nodeDataSchema` 新增 `imageEditSource: { sourceNodeId, assetId, version?, sourceKind? }`，`imageEditCapability()` 按目录显式声明 fail-closed，`runSnapshotSchema` 新增冻结的 `imageEditCapability`。旧画布缺省字段仍按普通图片生成节点处理。
- 前端：`AssetNode` 对已有回显的图片节点显示“修改图片”；`App.handleCreateImageEditNode()` 用全新节点 ID 创建图片生成节点，写入冻结来源引用，`input:imageEdit` 显式连线，和节点一起进入同一次历史事务，来源节点位置、尺寸、ID 与回显不变；`getNodePlacementRightOf()` 先向右再向下避让，每行最多 4 列。
- 编辑器：图片编辑节点显示“想用这张图修改什么？例如：换成夜景、去掉背景”，只读来源缩略图与固定版本标识；空提示词禁止提交；当前模型未声明图片编辑能力时显示原因并禁用运行。
- Provider：`/images/edits` 请求前校验冻结的 `imageEditCapability`，未声明返回 `IMAGE_EDIT_UNSUPPORTED` 零请求；未声明的参数字段返回 `IMAGE_EDIT_PARAMETER_UNSUPPORTED`；声明了编辑语义却没有原图输入返回 `IMAGE_EDIT_SOURCE_INPUT_MISSING`，不退回文生图；edits multipart 现在按声明转发全部已校验参数，不再只发 `size`。
- API：运行前新增 `checkImageEditCapabilities()` 预检（`IMAGE_EDIT_UNSUPPORTED` + 逐项 issues），并按编辑节点冻结的来源版本冻结资产（版本不存在返回 `asset_version_unavailable`）；来源节点被替换成另一张图时返回 `IMAGE_EDIT_SOURCE_ASSET_MISMATCH` 且保留节点与边。
- Worker：`StoredAssetReferenceResolver` 按冻结的 `imageEditSource.assetId/version` 读取不可变内容写入进程内快照；缺少明确版本时 fail-closed。

### 验证

- `pnpm typecheck`：13/13 通过。
- 领域 48、Provider 297、Worker 200、API 635（另 54 skip）通过。
- Web：640 项中 637 通过；`canvas-editor.test.tsx` 有 3 项在本次改动前后同样失败（资源提及 typeahead、推理强度菜单选项、`input:audioTrack` 句柄），不是本流程引入。
- 组件测试覆盖：入口显隐、创建后新节点与 `input:imageEdit` 显式边、自动打开编辑器、来源节点数据零变化、撤销/重做整体回滚、碰撞避让、关闭编辑器不删除节点、空提示词禁用、未声明能力的模型被拦下、运行失败后可改提示词重试。
- Playwright（Mock 栈）：`修改图片：桌面宽屏/方形画布新建节点并只把结果写入新节点` 2 项通过，覆盖自动打开编辑器、只读来源图、碰撞定位、空提示词禁用、结果只写入新节点以及控制台无错误。

### 真实上游验收（已执行）

在 `multimodal-canvas-app` compose 栈（`NODE_ENV=production`、`RUN_SERVICE=bullmq`、`WORKER_PROVIDER=newapi`，MinIO + Postgres + Redis）上用真实凭据完成一次端到端验收，操作者为本次请求显式授权计费。

| 项               | 结果                                                                    |
| ---------------- | ----------------------------------------------------------------------- |
| 端点             | `POST /v1/images/edits`（multipart：`model`、`prompt`、`n`、`image`）   |
| 精确模型         | `gpt-image-2`                                                           |
| 请求次数         | 每次运行 1 次 POST，无自动重试                                          |
| 运行状态         | `succeeded`                                                             |
| 供应商 requestId | `06edcd53-39a2-495c-833a-b0cdec46285a`                                  |
| usage            | `input_tokens=10683, output_tokens=16384, total_tokens=27067`           |
| 冻结来源         | `1a584b10-…` v1，快照 URL 为 `/v1/assets/1a584b10-…/versions/1/content` |
| 输入角色         | `imageEdit`                                                             |
| 冻结能力         | `{"declared":true,"mimeTypes":["image/png","image/jpeg","image/webp"]}` |
| 输出资产         | `d82aa3ad-…` v1，`image/jpeg`，320820 字节                              |
| 输出 SHA-256     | `bc6fb3edc230d00ddc4b62ba9321c5602dd04c4bda682dbb6af740f4f2191eb0`      |
| 结果写入范围     | 仅新编辑节点；来源节点位置、尺寸、ID 与资产不变                         |

同一轮另有一次真实请求被供应商以 HTTP 400 `content_policy_violation` 拒绝（输入为纯色占位图，被上游安全系统判定为不允许的内容）。该次记录了原始错误、未重试、未切换端点或模型，作为"请求确实到达供应商"的独立证据。

脱敏证据保存在 `.data/live-image-edit-acceptance.json`（不含 Key、原始签名 URL 或媒体内容）。

验收过程中发现并修复了两个真实缺陷：

1. `AiSettingsStore.listModels()` 在不带 `mediaType` 时（工作区节点编辑器使用的完整目录请求）不合并能力覆盖，导致"目录显式声明"的能力在客户端不可见；现在未过滤目录同样合并每个已声明媒体的覆盖。
2. Worker 的 `createNodeRunSnapshot()` 逐字段重建子快照时未继承 `imageEditCapability`，Provider 因此在请求前把已声明的编辑能力判为未声明。现已继承并补回归测试。

### 复现入口

```powershell
$env:MC_ACCEPTANCE_EMAIL='...'; $env:MC_ACCEPTANCE_PASSWORD='...'
$env:MC_ACCEPTANCE_AUTHORIZED='I_ACCEPT_UPSTREAM_CHARGES'
$env:MC_ACCEPTANCE_IMAGE_MODEL='gpt-image-2'
$env:MC_ACCEPTANCE_SOURCE_IMAGE='C:\path\to\local.png'
$env:WEB_BASE_URL='http://127.0.0.1:8080'
pnpm --filter @multimodal-canvas/web exec playwright test -c playwright.config.ts `
  e2e/image-edit-live.spec.ts --reporter=line
```

该用例不 Mock `/v1/**`，每次运行最多发出一次计费 POST；未设置 `MC_ACCEPTANCE_AUTHORIZED` 时自动跳过。输入图片只从本地文件读取，不抓取外部图片。

只读复核入口（不点击运行，零请求）：`e2e/image-edit-capability.spec.ts` 断言完整目录里能看到 `imageEdit` 声明，且编辑节点的运行按钮在填写提示词后可用。

### 当前生效的能力声明

能力声明写入 `model_capability_overrides` 表，API 启动时由 `PrismaAiSettingsStore.load()` 读取，没有 HTTP 路由可改；新建或调整声明需要写库后重启 API。

| 模型                     | mediaType | credentialId                 | 声明                                                                             |
| ------------------------ | --------- | ---------------------------- | -------------------------------------------------------------------------------- |
| `gpt-image-2`            | `IMAGE`   | `null`（全局，任意凭据生效） | `imageEdit: { supported: true, mimeTypes: [image/png, image/jpeg, image/webp] }` |
| `gpt-image-2.5-flare`    | `IMAGE`   | `null`（全局）               | 同上                                                                             |
| `gpt-image-2.5-sunburst` | `IMAGE`   | `null`（全局）               | 同上                                                                             |

只声明已经取得该部署真实证据的模型与格式。其它图片模型**没有**声明，编辑请求会在创建 Run 之前被拒绝（`IMAGE_EDIT_UNSUPPORTED`），不猜测它们支持 `/images/edits`。

验收用的临时覆盖（仅限当时那条凭据）已回滚；上表是按需求重新写入的正式声明。

### 2.5 模型取证（第二次真实上游验收）

文档层面已知 `gpt-image-2.5-flare` / `gpt-image-2.5-sunburst` 与 `gpt-image-2` 使用相同端点（[gpt-image-2.5 API 指南](https://apidog.com/blog/gpt-image-2-5-api/)、[DMXAPI 图片编辑文档](https://doc.dmxapi.cn/gpt-image-2.5-image-edit.html)），但第三方文档不能证明本部署，因此对每个模型各执行一次真实请求取证。

| 模型                     | 运行状态  | 耗时   | 输出        | 字节    | 供应商 requestId                       | usage                                                  |
| ------------------------ | --------- | ------ | ----------- | ------- | -------------------------------------- | ------------------------------------------------------ |
| `gpt-image-2.5-flare`    | succeeded | 26 秒  | `image/png` | 1138417 | `a47026cd-c042-423b-9c7d-46a1d2f04531` | input 421 / output 1650 / total 2071（标记 estimated） |
| `gpt-image-2.5-sunburst` | succeeded | 103 秒 | `image/png` | 1376485 | `c7b8d628-a0ce-43e0-83e4-78897d1f9848` | input 429 / output 1650 / total 2079                   |

两次都按冻结版本读取输入（`/v1/assets/<id>/versions/1/content`）、输入角色为 `imageEdit`、结果只写入新节点。输出 SHA-256 分别为 `0d978f7d…abe35083`（flare）与 `c023ae62…b47fab0cf`（sunburst）。

### HTTP 524 的边界

同一模型（`gpt-image-2`）同一端点的运行耗时对比：成功一次 **66 秒**，另两次分别 **127 秒**与 **132 秒**后返回 HTTP 524 `bad_response_status_code`。我们的 Provider 超时是 900 秒，因此 524 来自网关/CDN 侧的源站超时（Cloudflare 524 表示源站在超时窗口内未返回完整响应），不是本地超时。

推论边界：524 只说明请求已发出且**供应商侧的最终状态未知**，既不能断言失败也不能断言成功。系统因此不自动重试；需要操作者在供应商侧核对后再决定重发。想降低概率应降低 `quality`/`size`（例如 sunburst 本次已用 103 秒，接近 120 秒窗口）。

### 仍未证明

- 该部署的 `/images/edits` 是否接受 `quality`/`response_format`/`output_format`/`background` 等扩展字段：三次取证都只发送了 `model`、`prompt`、`n`、`image`，其余字段的映射只有本地测试。
- 供应商对 `/images/edits` 的输入尺寸范围与费用字段；观察到 `gpt-image-2` 返回 JPEG，两个 2.5 模型返回 PNG。
- 524 的正确恢复策略（重发、查询、等待）尚无该部署的可观测契约。
- 多参考图、局部重绘（mask）与连续编辑仍不在范围内。上方两份第三方文档提到 2.5 系列支持 mask，但本部署未取证，因此本期不开放该输入角色。
