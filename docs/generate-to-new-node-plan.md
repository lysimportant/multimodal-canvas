# 生成到新节点：覆盖生图与回显后图生图

## 0. 已确认的产品口径

两个按钮，语义不同，不是同一套生成换个落点：

1. **生成**：走**生图 / 纯生成**。结果写当前节点。空节点第一次生成、以及已有回显后再点「生成」覆盖回显，都走这条。图片供应商是 `/images/generations`。
2. **新节点**：只在节点**已经有回显资源**时出现。走**修改路径**。图片上这就是现有「修改图片」图生图：当前回显当原图，提示词当修改说明，新建子节点承载结果，父节点回显不动。图片供应商是 `/images/edits`。

「修改图片」不再是第三条用户路径。「新节点」就是修改路径；图片实现复用 `handleCreateImageEditNode` 的来源冻结与 `input:imageEdit` 连线，并带上当前提示词后立刻运行。

---

## 1. 目标与范围

PC Web 画布，四类节点都按「无回显只能生成；有回显才能选覆盖生成或修改到新节点」。

- 无回显：只有「生成」。图片=文生图，文字/音频/视频=各类型纯生成。结果写当前节点。
- 有回显点「生成」：仍是纯生成，覆盖当前回显。图片不得因此改成图生图。
- 有回显点「新节点」：走修改路径，当前回显作为新节点的输入来源。图片必须图生图。文字/音频/视频把当前回显按该类型已有入边角色接到子节点，不新造未确认的编辑端点。
- 只有点「新节点」才会自动建子节点并立刻发请求。添加资源、打开编辑器、改模型/参数、画布加载都不建节点、不发请求。

移动端专用布局、批量多图、局部蒙版、自动清理分叉列为后置。

### 1.1 两个按钮与「修改图片」

| 入口 | 何时出现 | 语义 | 图片供应商路径 | 是否立刻运行 |
| --- | --- | --- | --- | --- |
| 生成 | 所有生成节点 | 纯生成；有回显则覆盖 | `/images/generations` | 是 |
| 新节点 | 已有回显 | 修改路径；图片=图生图 | `/images/edits` | 是 |
| 修改图片（悬浮栏旧入口） | 图片已有回显 | 与「新节点」同一条修改路径，不另做第三套逻辑 | `/images/edits` | 是（带当前提示词） |

来源图片节点不能原地「生成」，但已有回显，可以出「新节点」走图生图。

---

## 2. 不可违反的边界

- **「生成」绝不图生图**：现有 `runNodeInPlace` 对当前节点 POST，图片无编辑来源时 Worker 走 `/images/generations`。不得因为当前已有回显就把原地生成改成 edits。既有「结果在原节点 / 节点数不变」冒烟不得改写。
- **「新节点」才分叉，且走修改**：父节点零写入（回显、`assetId` / `contentUrl` / `resultAsset` / `manualOutput` / `runStatus`、位置、尺寸都不改）。
- **图片新节点必须是图生图**：子节点全新 ID；`imageEditSource` 指向**被点击节点当前回显**（生成结果用 `resultAsset` 的 assetId+version，`sourceKind: result`；上传来源用 `assetId`，`sourceKind: asset`）；显式边 `output:image` → `input:imageEdit`。来源是当前节点自己的回显，不是父节点更早的编辑源。禁止依赖隐式推断。
- **子节点不带父节点产物字段**：`assetId`、`contentUrl`、`mimeType`、`resultAsset`、`manualOutput`、`manualOutputRunId`、`runStatus`、`runProgress`、`runError`、`stale`。
- **提示词要带上**：子节点继承当前提示词 / `promptDocument` / `resourceRefs`、模型、凭据、参数、推理强度。无提示词：两条按钮都禁用；「新节点」不建节点、不发请求。
- **模型必须声明图片编辑**：图生图在创建 Run 前走现有 `checkImageEditCapabilities`。未声明 `imageEdit` 时 `IMAGE_EDIT_UNSUPPORTED`，零上游请求，不得退回 `/images/generations`。
- **一次点击一个子节点**。失败后原地重试，不重复建节点。
- **不自动重试** `524`，不改模型、不换端点。
- 运行前冻结原图 `assetId + version`。

---

## 3. 用户流程

### 3.1 回显判定

与能否展示产物一致，不看「曾经跑过」：

- 「新节点」出现条件：当前能展示回显（`resultAsset` 可解析内容，或 `assetId + contentUrl`，含手动输出仍在展示的产物）。
- 生成节点和已有图片回显的来源节点都可以出「新节点」。
- 失败但留着旧回显：要出现，这正是保留旧图、把修改结果放到旁边。
- 空节点、产物缺失：不出现「新节点」。
- 忙碌或停用：可见但禁用。

领域层用 `nodeHasEchoPreview(node)`；图片修改来源继续用现有 `isImageEditSourceNode`。

### 3.2 图片主流程

```text
空图片生成节点
  -> 只有「生成」
  -> 点「生成」：POST 当前节点 /runs，Worker /images/generations，结果写回当前节点

当前图片节点已经有回显
  -> 「生成」+「新节点」
  -> 点「生成」：仍 POST 当前节点 /runs，Worker /images/generations，覆盖当前回显
  -> 点「新节点」
       · 冻结当前回显为原图
       · 新建图生图子节点（imageEditSource + input:imageEdit）
       · 拷贝当前提示词、模型、参数
       · 立刻对子节点 POST /runs
       · Worker /images/edits（原图文件 + prompt + model）
       · 父节点回显不动
  -> 子节点有回显后，再点它的「新节点」，原图改成这张新图，形成下一环图生图
```

### 3.3 状态

| 状态 | 生成 | 新节点 |
| --- | --- | --- |
| 无回显 | 可见；无提示词则禁用 | 不渲染 |
| 有回显、无提示词 | 禁用 | 可见但禁用；不建节点 |
| 图片模型未声明 imageEdit | 仍可生图 | 禁用或提交前失败；零 edits 请求 |
| 分叉成功 | — | 子节点回显新图；提示「`<子节点名>` 已完成」 |
| 分叉后运行失败 | — | 父节点不变；子节点可原地重试 |
| 建节点失败 | — | 回滚节点和边 |

---

## 4. 数据与字段

不给节点增加结果落点字段。落点由点了哪个按钮决定。

### 4.1 图片「新节点」子节点

| 类别 | 字段 |
| --- | --- |
| 继承 | mediaType=image、mode=generate、modelAlias、credentialId、parameters、inferenceStrength、prompt / promptDocument、resourceRefs |
| 不继承 | 产物与运行态；也**不复制**父节点旧的 imageEditSource |
| 新写入 | 新 id、label（沿用 `createUniqueImageEditLabel`）、imageEditSource.sourceNodeId=父节点 id、assetId=父节点当前回显资产、已知则带 version、sourceKind=result 或 asset |

入边：只新建一条父 → 子的 `input:imageEdit`。不要把父节点自己的旧编辑边再复制一份，否则会变成改更早的原图，而不是改当前回显。

文字/音频/视频「新节点」：子节点继承提示词与模型参数，并把父节点当前回显按现有角色接到子节点；禁止为了连线去猜未落地的编辑 URL。

---

## 5. 前端实施

### 5.1 分发

- `runNode(node, 'sameNode')` → `runNodeInPlace(node)`。键盘 R、命令面板、「生成」、右键「开始生成」都走这里。
- `runNode(node, 'newNode')` → 必须 `nodeHasEchoPreview`；图片还必须 `isImageEditSourceNode`。然后 `runNodeAsNewChild(parent)`。
- `runNodeAsNewChild` 对图片复用「修改图片」建节点逻辑（冻结回显、`imageEditSource`、`input:imageEdit`、碰撞避让、同一次历史事务），再拷贝提示词，立刻 `runNodeInPlace(child)`。
- 悬浮栏「修改图片」改为调用同一条 `runNodeAsNewChild`，不要再留一套只建空节点、不运行的逻辑。

### 5.2 界面

- 快速编辑器：无回显一个「生成」；有回显加次按钮，可访问名称「生成到新节点」或「修改到新节点」，可见文案可用「新节点」。
- 图片有回显时主按钮仍叫「生成」（生图覆盖）；次按钮才是图生图。
- 节点悬浮栏不要同时摆「修改图片」和「新节点」两套入口；保留一个，都进修改路径。
- 右键：有回显时在「开始生成」下加「生成到新节点」。

---

## 6. 运行与 URL

浏览器始终：

- `POST {API_BASE_URL}/v1/nodes/{nodeId}/runs`
- 覆盖生图：`nodeId` = 当前节点
- 新节点图生图：`nodeId` = 新建子节点
- 本地默认 `http://localhost:3000`
- 随后 `GET {API_BASE_URL}/v1/runs/{runId}`

Worker（New API，凭据 baseUrl 空路径会补 `/v1`）：

- 生图：「生成」按钮 → `POST {baseUrl}/images/generations`，JSON：`model`、`prompt`、`n: 1`、节点参数
- 图生图：「新节点」按钮 → `POST {baseUrl}/images/edits`，multipart：`model`、`prompt`、`image` 原图文件、已声明参数
- `model` 都是当前节点已选 `modelAlias`，不换模型。图生图额外要求目录 `capabilities.imageEdit`

---

## 7. 兼容

- 旧画布零迁移。「生成」仍覆盖当前节点且仍是生图。
- 不新增画布字段。
- 撤销一次去掉该次分叉的节点和 `input:imageEdit` 边。
- 既有空节点生图冒烟保持。把「修改图片」从「只建空节点」改成立刻运行，是本任务对旧入口的有意合并；相关测试要改成与「新节点」同一条断言，而不是保留两套产品逻辑。

---

## 8. 测试

- `nodeHasEchoPreview`、`isImageEditSourceNode`。
- 空图片节点：没有「新节点」；点「生成」0 新节点，请求落到当前节点。
- 有回显点「生成」：0 新节点，父节点回显被覆盖；不得出现 `imageEditSource` 新写入。
- 有回显点「新节点」：+1 节点、+1 条 `input:imageEdit`、父子 ID 不同、子节点 `imageEditSource.sourceNodeId` 为父节点、资产为父节点当前回显、恰好 1 次 `POST /v1/nodes/{子节点}/runs`、请求体含提示词。
- 父节点字段深比较不变。
- 连续两环：孙节点的原图是子节点回显，不是祖父那张。
- 模型未声明 `imageEdit`：新节点按钮禁用或提交前失败，fetch 次数为 0。
- 无提示词：不建节点、0 请求。
- Playwright：保留四类节点「点生成结果在原节点」。新增「有回显点新节点，图片走修改路径，原图还在父节点」。

---

## 9. 后置

- 连续图生图会增加节点，本期只靠撤销和手动删除。
- 多原图、mask、视频专用编辑端点未确认前不猜 URL。
- 不要把「生成」缺省改成新节点，也不要给旧画布补 resultTarget=newNode。

## 10. 已否决

- 有回显点「新节点」仍走 `/images/generations`（与本次口径相反）。
- 「生成」和「新节点」生成语义等价、只换写入节点。
- 把所有「生成」默认改成分叉。
- 「修改图片」继续作为不自动运行的第三条路径。
- 图生图子节点复制父节点旧 `imageEditSource`，去改更早的原图而不是当前回显。
