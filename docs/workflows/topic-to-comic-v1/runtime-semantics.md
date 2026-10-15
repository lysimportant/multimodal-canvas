# topic-to-comic@0.1.0 —— 运行时语义（P1 草案）

> **状态：草案（DRAFT）。** 本文规定 `WorkflowRun` / `WorkflowStepRun` 的运行时语义。
> 字段名、错误码、步骤 id、策略名一律取自同目录的 `contracts.ts`（Zod 契约）与
> `workflow-definition.v1.json`（步骤定义）；**本文不新增任何字段名或错误码**。
> 两者冲突时以那两份文件为准。所有"必须/禁止"都是可测断言，不是建议。

涉及的 15 个步骤（`workflow-definition.v1.json` `steps[]`）：

| 类别 | 步骤 id | `vendorCall` |
| --- | --- | --- |
| transform | `s0_brief`、`s5_render_specs`、`s9_export` | `false` |
| generate | `s1_premise`、`s2_script`、`s3_panel_plan`、`s3_asset_manifest`、`s7_quality` | `true` |
| gate | `g_story`、`g_assets`、`g_final` | `false` |
| fanout | `s4_asset_candidates`、`s6_panel_render`、`s8_layout`、`s8_render_pages` | `s8_layout` 为 `false`，其余 `true` |

---

## 1. 三层关系

```
WorkflowRun                      一次业务编排（一句主题 → 一份分页漫画）
  └─ WorkflowStepRun             逻辑步骤，或 foreach 展开后的一个子项
       └─ Run                    0..N 个现有 Run（实际生成，含技术重试）
```

三层各自**只回答一个问题**，不越界：

- `WorkflowRun` 回答"这次业务编排整体到哪一步了、预算还剩多少、还需不需要人"。
- `WorkflowStepRun` 回答"这一个逻辑步骤（或这一个子项）在当前修订上成功了吗、产物是什么、
  有没有被批准"。
- `Run` 回答"这一次调用 vendor 的请求成功了吗"（既有语义，**不新增字段语义**）。

### 1.1 `WorkflowRun`（新增）

| 字段 | 职责 |
| --- | --- |
| `id` | 本编排的稳定身份（`stableIdSchema`） |
| `projectId` | 归属项目；画布投影的落点 |
| `definitionId` | 固定 `"topic-to-comic"`（与 `comicExportManifestSchema.definitionId` 的 `z.literal` 一致） |
| `definitionVersion` | `"0.1.0"`；导出时写入 `manifest.definitionVersion`，比对失败即 `WF_EXPORT_VERSION_MISMATCH` |
| `definitionDigest` | 见 §3；进入每一个步骤的 `inputFingerprintMaterial` |
| `contractSchemaVersion` | `CONTRACT_SCHEMA_VERSION = 1`；不支持即 `WF_SCHEMA_VERSION_UNSUPPORTED` |
| `brief` | 归一化后的 `comicBriefSchema` 实例（含 `budget`、`limits`、`modelBindings`） |
| `briefDigest` | `brief` 的规范 JSON 摘要；写入 `comicExportManifestSchema.briefDigest` |
| `status` | `running` / `awaiting_decision` / `succeeded` / `failed` / `needs_review` / `cancelled`。**`needs_review` 已列入本枚举**（P1 裁决，见 `FINDINGS-p1.md` F-22）：它是**可再入**状态，`succeeded` 的编排收到迟到结果时按 §9.3 转为 `needs_review` 而**不是**静默忽略，人工处置后再回到 `succeeded` 或 `failed`。`needs_review` **不属于** `RunStatus`（`prisma/schema.prisma:28-38`），只存在于工作流层 |
| `revision` | 任一产物或审批变化即 `+1`；投影写回用它做 `expectedRevision` |
| `budgetState` | 预留与结算计数：`textGenerations`、`imageGenerations`、`visionReviews`、`promptOptimizations`、`vendorRequests`、`regenerationsPerItem`、`candidatesPerItem` |
| `createdAt` / `updatedAt` / `terminalAt` | 审计与成本归集 |

**`WorkflowRun` 不持有任何 vendor 凭据，也不持有模型名**：模型只以别名出现在
`comicBriefSchema.modelBindings`（`contracts.ts:336`），理由见 `contracts.ts:331-335`。

### 1.2 `WorkflowStepRun`（新增）

| 字段 | 职责 |
| --- | --- |
| `id` | 步骤运行身份；下游以 `generatedArtifactRefSchema.stepRunId` 引用它 |
| `workflowRunId` | 归属编排 |
| `stepId` | `workflow-definition.v1.json` 的 `steps[].stepId` |
| `itemKey` | foreach 子项身份；非 fanout 步骤用 `step:{stepId}`（对应 `canvasProjectionPolicy.keyedBy` 的 `step:{stepId}`） |
| `generationRevision` | §5；用户"再画一张"提升它 |
| `inputFingerprint` | §3；本步骤本次提交的内容指纹（sha256 hex） |
| `status` | `pending` / `running` / `awaiting_decision` / `approved` / `rejected` / `stale` / `succeeded` / `failed` / `needs_review` / `cancelled` |
| `revision` | 本步骤的修订计数；`approvalDecisionSchema.expectedStepRevision` 比对它 |
| `outputSchema` | `STEP_OUTPUT_SCHEMAS`（`contracts.ts:1109`）的键；与步骤的 `outputSchema` 双向命中 |
| `artifact` / `artifactDigest` | 结构化产物与其摘要；`approvalDecisionSchema.targetArtifactDigest` 绑定到**这个**摘要 |
| `runIds` | 0..N 个实际 `Run`。**gate / 纯转换 / 排版 / 导出为 0**（见 1.4） |
| `auditRunIds` | 迟到或指纹不符的 `Run`，只做审计，见 §9 |
| `attempt` | 技术重试次数，与 `Run.attempt` 同源 |
| `approvalId` | 有效审批（`ApprovalDecision.approvalId`），无则 `null` |
| `issueCode` | 终止时的 `WorkflowIssueCode`，无则 `null` |
| `startedAt` / `finishedAt` | 审计 |

### 1.3 `Run`（既有，不改）

`Run`（`prisma/schema.prisma:356`）保持原样：`id` / `projectId` / `targetNodeId` /
`status` / `attempt` / `retryOf`（`:370`）/ `idempotencyKey`（`:371`）/ 结果。
`WorkflowStepRun` 通过 `runIds` 引用 `Run.id`，**不复制 `Run` 的任何列**。

**`Run` 不知道 `WorkflowRun` 的存在**，反之不成立。这是单向依赖：
删除 `WorkflowRun` 不影响任何 `Run` 的既有语义。

### 1.4 不创建假生成 Run

以下步骤 `vendorCall: false`，**必须不创建任何 `Run`**，`runIds` 恒为空数组：

| 步骤 | 类别 | 产物 | 为什么不能有 `Run` |
| --- | --- | --- | --- |
| `s0_brief` | transform | `comic_brief` | 只是用户输入归一化 + 预检；`s0_brief.preflight.issueCodes` 已在 `contracts.ts` 表达 |
| `g_story` / `g_assets` / `g_final` | gate | — | gate 是人工决定，不是生成；伪造 `Run` 会让"人工批准"伪装成"生成成功" |
| `s5_render_specs` | transform | `panel_render_spec_set` | 纯编译（`compilationRules.contextTrimming` 裁剪），无 vendor 调用 |
| `s8_layout` | fanout（`vendorCall: false`） | `page_layout` | 排版是**确定性纯函数**（`s8_layout.determinism.isDeterministic: true`） |
| `s9_export` | transform | `comic_export_manifest` | 纯汇总；`exportPolicy` 只做完整性拒绝 |

**理由（这条是硬的）**：`contracts.ts:469-473` 的 `s7_quality.threeDistinctFacts` 要求
"生成成功 / 结构校验通过 / 人工批准"是三件**独立**的事实。若 gate 也建 `Run`，
"生成成功"这一列就会包含非生成事件，三者的区分立刻失效，
`retryPolicy.classification` 里"已有结果但归档失败 → `recover_existing_result`"
也会误命中 gate。

对 `s8_layout` 要额外说明：它是 fanout 但**确定性**。相同输入必须产出相同排版
（`sameInputsMustProduceSameLayout: true`），因此它的"重跑"是纯重算，不需要新 `Run`，
也不消耗预算。

---

## 2. 唯一键

```prisma
@@unique([workflowRunId, stepId, itemKey, generationRevision])
```

### 2.1 为什么原方案 `unique(workflowRunId, stepId, inputFingerprint)` 不够

四条独立的理由，任何一条都足以否定它：

**(1) 表达不了 fan-out 子项身份。**
`s4_asset_candidates`、`s6_panel_render`、`s8_layout`、`s8_render_pages` 都是 fanout：
同一个 `stepId` 下有 N 个子项。若两个子项的 `normalizedInputs` 恰好相同——
例如两个纯道具场景共用一条 `requirementPrompt`，或两个格的 `renderSpec` 完全一致——
它们的 `inputFingerprint` 相同，唯一键相同。第二个子项**无法建行**，会被静默当成重放
而不派发。用户看到的是"少了一个道具"，线上日志里什么错都没有。

**(2) 分不清技术恢复与用户主动重生成。**
技术重试**刻意不改变**指纹
（`s4_asset_candidates.retryPolicy.technicalRetryKeepsGenerationRevision: true`）。
而用户"再画一张"时，如果提示词一个字都没改（恰恰是最常见的"这张不行，换一张"），
`normalizedInputs` 与 `frozenPromptText` 也完全不变，**指纹同样不变**。
于是 `unique(…, inputFingerprint)` 下这两件事**完全不可区分**：
第二次"再画一张"被当成重放，既不派发也不报错。
`WF_REPLAY_GENERATION_REVISION_REQUIRED`（`contracts.ts:162`）就永远没有触发场景。

**(3) 用派生值当身份是循环依赖。**
`inputFingerprintMaterialSchema`（`contracts.ts:1007`）的材料里**本身就包含**
`stepId`、`itemKey`、`generationRevision`（还有 `definitionDigest`）。
算指纹必须先知道 `itemKey`；而查重要先算出指纹。更要命的是：
指纹材料**增删一个字段**，所有历史行的唯一键语义就静默改变——
一次契约演进会让全部历史 `WorkflowStepRun` 看起来"从未存在过"。

**(4) 时序不可表达。**
指纹**刻意排除**时间戳与进度（`contracts.ts:1004`），所以它天然无法表达
"同一逻辑步骤在同一修订上先后提交了两次"。而唯一键的核心职责恰恰是裁决并发提交。

**结论**：身份必须是**声明式**属性，与内容指纹解耦。
`(workflowRunId, stepId, itemKey, generationRevision)` 四项分别回答
"哪次编排 / 哪个步骤 / 哪个子项 / 第几次生成"，全部可由调用方直接给出，
不需要先算指纹。指纹退化为**内容等值断言**（§8），而不是身份。

### 2.2 该唯一键约束的三条硬规则

- **R2.1** 提交前必须先按这四项查一次；命中即走**恢复路径**（§12），**不得**新建。
- **R2.2** 命中后必须再做五项等值断言：
  `stepId`、`itemKey`、`generationRevision`、`inputFingerprint`、`definitionDigest`
  全部相等才允许当作重放复用；任一项不等即 `WF_REPLAY_FINGERPRINT_MISMATCH`。
  这条断言同时兜住 `submitIdempotencyKey` 的折叠碰撞（见 §4.3）。
- **R2.3** 用户"再画一张"必须**先提升 `generationRevision` 再提交**，
  而不是改指纹或换幂等键（`s7_quality.reworkPolicy.mustNotBeExpressedAsNetworkRetry: true`）。

---

## 3. 两层指纹

两层解决两个不同的问题，**不可合并**。

| | 定义摘要 `definitionDigest` | 步骤输入指纹 `inputFingerprint` |
| --- | --- | --- |
| 回答 | "这条流水线的**定义**变了吗" | "这一步这一次的**输入**变了吗" |
| 作用域 | 整份 `workflow-definition.v1.json` | 一个 `(stepId, itemKey, generationRevision)` |
| 变化频率 | 改定义才变（罕见） | 每次输入变化都变（常见） |
| 作用 | 定义一变，**所有**步骤的历史指纹一起失效 | 只让本步骤与依赖它的下游失效 |
| 材料 | `definitionDigestInputs` 列出的 11 个顶层键 | `inputFingerprintMaterialSchema` 的 12 个字段 |
| 算法 | 规范 JSON（§3.3）→ sha256 | 同左 |

### 3.1 `definitionDigest` 材料

照抄 `workflow-definition.v1.json` `definitionDigestInputs`，**恰好 11 项**：

`schemaVersion`、`id`、`version`、`inputSchema`、`outputSchema`、`steps`、
`taskTemplates`、`retryPolicy`、`budgetPolicy`、`canvasProjectionPolicy`、`exportPolicy`

**刻意不在清单里**（改了它们 `definitionDigest` 不变）：
`title`、`form`、`formNonGoals`、`contractModule`、`inputSchemaRef`、
`contractSchemaVersion`、`runtimeReferences`、`definitionDigestInputs` 自身。

⚠️ **需要评审确认的一点**：`form`（`"paged-comic"`，即"首版形态"本身）不在
`definitionDigestInputs` 里，`formNonGoals` 也不在。这意味着把形态从分页漫画改成
条漫、或新增一条非目标，**不会**改变 `definitionDigest`，因此**不会**让已存在的
`WorkflowRun` 的指纹失效——旧编排会继续按新定义被解析。
若这是有意的（形态是产品决策，不是契约），应当写明；若不是，应把 `form` 与
`formNonGoals` 加入 `definitionDigestInputs`。

### 3.2 `inputFingerprint` 材料（与 `contracts.ts` 一一对应）

`inputFingerprintMaterialSchema`（`contracts.ts:1007-1025`）共 12 个字段，
全部为必填（`frozenPromptText` 为 `string | null`，但**必须出现**）：

| # | 字段 | 语义 |
| --- | --- | --- |
| 1 | `schemaVersion` | `CONTRACT_SCHEMA_VERSION = 1` |
| 2 | `definitionDigest` | §3.1 的结果（sha256 hex） |
| 3 | `stepId` | `workflow-definition.v1.json` 的 `steps[].stepId` |
| 4 | `itemKey` | 子项身份；长度 1..160 |
| 5 | `generationRevision` | 1..1000 |
| 6 | `taskTemplateDigest` | `task-templates.v1.json` 里**该步骤引用模板正文**的 sha256 |
| 7 | `outputSchemaVersion` | 该产物 schema 的版本；`taskTemplates.contractChangeRule` 要求模板改字段集合时必须提升它 |
| 8 | `normalizedInputs` | 按 `inputBindings` 归一化后的输入值（不是原始用户输入） |
| 9 | `upstreamArtifactDigests` | 上游产物摘要数组 |
| 10 | `frozenModelBinding` | `{ alias, parameters }`；别名 + **显式参数**，不含凭据 |
| 11 | `orderedAssetRefs` | `approvedAssetRefSchema[]`，**保序**（顺序即语义） |
| 12 | `frozenPromptText` | 需要冻结提示词正文的步骤填写，否则 `null` |

**必须排除**（`contracts.ts:1004` 明确规定）：时间戳、进度、临时 URL、
**画布节点坐标**、供应商 job id、`Run.id`、`attempt`、凭据。

**必须包含**：**成品页的排版坐标**。理由：`pageLayoutSchema.panels[].rect`
（`contracts.ts:744`）与 `balloons[].anchor` / `tailTarget` / `fontSize` /
`readingIndex` 是**内容输入**而非展示——布局变了成品就变了。
这与"画布节点坐标不进指纹"并不矛盾：画布节点坐标是编辑器里的摆放位置，
排版坐标是成品页里的内容。

`s8_layout.determinism.layoutCoordinatesParticipateInFingerprint: true`
（`workflow-definition.v1.json:537`）是本条的权威表述。

**排除 `Run.attempt` 与 `retryOf` 的理由**：它们是**技术重试**的记账，
不属于"这一次要生成什么"。把它们放进指纹会让技术重试改变指纹，
从而破坏 §5 的"技术重试保留 `generationRevision` 与指纹"这一条。

### 3.3 规范 JSON 规则（照抄 `contracts.ts:1030-1032` 与 `:1033-1048`）

`canonicalizeForFingerprint` 的规则，**逐条照抄，不得变体**：

1. **对象键排序**：`Object.keys(...).filter(k => record[k] !== undefined).sort()`。
2. **丢弃 `undefined`**：值为 `undefined` 的键直接不出现（不是写成 `null`）。
3. **数组保序**：`value.map(...)`，不排序、不去重。
4. **不做数值规范化**：`1` 与 `1.0` 视为不同，因为**参数精度本身就是输入**。
5. `null` → `'null'`；非有限数（`NaN` / `Infinity`）→ `'null'`。
6. 字符串/布尔以外的标量走 `JSON.stringify`。
7. 对象体形如 `{"k":v,"k2":v2}`，无空格。

**哈希算法由调用方注入**（`contracts.ts` D3）：`computeInputFingerprintMaterial()`
只产出规范字符串，`inputFingerprint(material, hash)` 接收 `hasher`。
**契约模块不得 `import 'node:crypto'`** —— `packages/domain` 同时被 web 侧引用，
直接引入会污染浏览器构建。Node 侧传 sha256 实现，浏览器侧传 WebCrypto 包装。

**指纹材料不可换**（D3 原文）：材料变了，所有历史幂等键都失效。

---

## 4. 提交幂等键

### 4.1 生成规则（照抄 `contracts.ts:1070-1088`）

```
itemKeyHashInput = `${definitionId}|${stepId}|${itemKey}`
itemPart         = itemKeyHashInput.length <= 80
                     ? itemKeyHashInput
                     : `${definitionId}|${stepId}|h${simpleHash(itemKeyHashInput)}`
key              = `${itemPart}|r${generationRevision}|${fingerprint.slice(0, 32)}`
```

即：**由 `definitionId` + `stepId` + `itemKey` + `generationRevision` + 指纹前 32 位**构成。

### 4.2 长度上限 200 的预算证明

上限来自 `Run.idempotencyKey`（`packages/domain/src/index.ts:1651`
`z.string().trim().min(1).max(200).optional()`）。

- 保持不折叠要求 `len(definitionId) + 1 + len(stepId) + 1 + len(itemKey) <= 80`。
- 折叠形态长度 = `len(definitionId) + len(stepId) + 50`。
  推导：折叠 `itemPart` = `len(def) + 1 + len(step) + 1 + 1 + 8`；
  再加 `|r` + 最多 4 位修订号（上限 1000）+ `|` + 32 位指纹 = `6 + 1 + 32 = 39`。
  合计 `len(def) + len(step) + 11 + 39 = len(def) + len(step) + 50`。
- `definitionId` 实际固定为 `"topic-to-comic"`（14）；`stepId` 受 `stableIdSchema`
  约束 ≤ 64。最坏情况（`stepId` 取满 64）：`14 + 64 + 50 = 128 <= 200` ✅
- 若将来 `definitionId` 也用满 `stableIdSchema` 的 64：
  `64 + 64 + 50 = 178 <= 200` ✅（余量 22 字符）

**结论**：对任何 schema 合法输入，键长恒 ≤ 178，200 上限成立。
超出即抛 `WF_REPLAY_KEY_TOO_LONG`（**但见 4.3 与 §3 的登记项**）。

### 4.3 折叠的三条必须遵守的规则

- **R4.1** 折叠是**最后手段**，只应在 `itemKey` 确实过长时发生。
  当前实现的触发条件是整串超 80，因此长 `stepId` 也会让短 `itemKey` 被折叠——
  这是已知缺陷（已登记），运行期**不得**依赖折叠后的字符串去反推 `itemKey`。
- **R4.2** `simpleHash` 是 32 位非加密折叠哈希，**存在碰撞**。
  因此**任何幂等键命中都必须再做 §2.2 的五项等值断言**，
  断言失败即 `WF_REPLAY_FINGERPRINT_MISMATCH`，**绝不**把碰撞当成重放。
- **R4.3** 幂等键只用于**提交**，不用于**查询**。
  查询身份一律用 `@@unique([workflowRunId, stepId, itemKey, generationRevision])`。

### 4.4 恢复必须读持久化记录（硬规则）

> **恢复必须读取已持久化的 `Run` 与冻结快照，禁止重新读实时画布后拿旧幂等键提交。**

理由：`normalizedInputs` 是从画布与上游产物归一化出来的。
若恢复时重新读**实时画布**，而画布已被人工改动（新增节点、改提示词、换参考图），
归一化结果就与当初不同 → 指纹不同 → `submitIdempotencyKey` 产出**不同的键** →
`Run @@unique([projectId, idempotencyKey])`（`prisma/schema.prisma:382`）
完全挡不住，于是同一件事被**第二次付费**派发。

正确顺序（**必须**按此顺序）：

1. 按 §2 的唯一键读出 `WorkflowStepRun`。
2. 读出它的 `runIds` 与 `auditRunIds`。
3. 对每个 `Run.id`，读**已持久化**的 `Run`（含 `idempotencyKey`、`status`、
   `attempt`、`retryOf`）与**冻结快照**（
   `packages/execution/src/index.ts` 的 `requireFrozenNodeRequest` 语义）。
4. 读 `RunSendIntent.status`（`prisma/schema.prisma:544`，唯一键
   `@@unique([runId, nodeId, attempt])` 在 `:557`）。
5. **只有**在第 1 步查无此键、且第 2–4 步确认无任何已持久化痕迹时，
   才允许走 §12 的提交事务新建。

---

## 5. 生成修订 vs 技术重试

两个**正交**的维度（`contracts.ts` D6）。混用会导致换幂等键重发 = 重复付费。

| 维度 | 生成修订 `generationRevision` | 技术重试 `attempt` / `retryOf` |
| --- | --- | --- |
| 触发者 | **人**（"这张不行，再画一张"；质检返工） | **系统**（网络错误、超时、5xx、限流） |
| `itemKey` | **保留** | **保留** |
| `generationRevision` | **提升 +1** | **保留不变** |
| 幂等键 | **变化**（含 `r{revision}` 段） | **不变** |
| `inputFingerprint` | 提示词未变时**可能不变** | **不变** |
| 数据库痕迹 | **新建** `WorkflowStepRun` 行 | 同一行 `attempt += 1`；或 `Run.retryOf` 指向原 `Run` |
| 旧产物 | **保留**（`mustPreserveOldArtifacts: true`） | 保留 |
| 计费 | 计入 `regenerationsPerItem`，**消耗预算** | 计入 `vendorRequests`；不改 `regenerationsPerItem` |
| 画布节点 | **不新建节点**（`stableAcrossRetries` / `mustNotCreateNodePerAttempt`） | **不新建节点** |
| 上限 | `budget.maxRegenerationsPerItem`（≤ 10） | `retryPolicy.maxAttempts`（多为 2） |
| 错误码 | `WF_REPLAY_GENERATION_REVISION_REQUIRED` | `WF_STATE_SEND_UNKNOWN`（发送状态不确定时） |

权威表述：
- `workflow-definition.v1.json` `retryPolicy.dimensions`：
  `technicalRetry` = 保留原 `itemKey` 与 `generationRevision`，恢复原 `Run` 或走
  `Run.retryOf` 链（`prisma/schema.prisma:370`）；
  `userRegeneration` = 提升 `generationRevision`，**即使提示词未变**。
- `s7_quality.reworkPolicy`：`mechanism: "increment_generation_revision_for_itemKey"`、
  `mustPreserveOldArtifacts: true`、`countsAgainstBudget: true`、
  `mustNotBeExpressedAsNetworkRetry: true`、
  `userInitiatedRegenerationRequiresNewRevision: true`。

### 5.1 三条必须遵守的规则

- **R5.1** 只有**没有**任何 `RunSendIntent` 痕迹时，才允许把失败判为技术重试。
  只要发送状态不确定，一律 `needs_review` + `WF_STATE_SEND_UNKNOWN`，**不得**重发（§12）。
- **R5.2** 不论哪种重试，都**不得**新建画布节点。
  `canvasProjectionPolicy.mustNotCreateNodePerAttempt: true`；历史进
  `historyLocation: "run_and_artifact_list"`。
- **R5.3** 技术重试**不得**改变 `inputFingerprint`。
  若发现指纹变了，说明输入真的变了，必须走生成修订而不是重试。

---

## 6. 审批状态机

### 6.1 状态

| 状态 | 含义 |
| --- | --- |
| `pending` | 步骤已就绪但尚未产出待审产物 |
| `awaiting_decision` | 产物已冻结、`artifactDigest` 已记录，等待人工决定 |
| `approved` | 存在**有效** `approved` 决定，绑定到 `targetArtifactDigest` |
| `rejected` | 存在有效 `rejected` 决定；步骤回到可重画 |
| `stale` | 审批所依赖的输入已变更；该审批**不再可信** |

### 6.2 转换表

| # | 转换 | 触发条件 | 幂等行为 | 错误码 |
| --- | --- | --- | --- | --- |
| T1 | `pending → awaiting_decision` | 该步骤全部 `dependsOn` 已 `completed`，且产物通过 `validateComicArtifacts()`（返回空数组） | 已在 `awaiting_decision` 再触发**不得**改写 `artifactDigest` | 结构校验失败则不进入：`WF_SCHEMA_VERSION_UNSUPPORTED` / `WF_DUPLICATE_STABLE_ID` / `WF_REF_DANGLING` … |
| T2 | `awaiting_decision → approved` | 收到 `decision: 'approved'`，且 `expectedStepRevision === stepRun.revision`，且 `targetArtifactDigest === stepRun.artifactDigest`，且 `targetKind !== 'story_scope'` 时 `selectedCandidateKey` 存在 | 同一 `approvalId` 重复提交**无副作用**，返回首次结果（`duplicateApprovalIsNoop: true`） | revision 不符 → `WF_STATE_APPROVAL_STALE`；digest 不符或 `selectedCandidateKey` 缺失 → `WF_STATE_APPROVAL_TARGET_MISMATCH` |
| T3 | `awaiting_decision → rejected` | 同上，`decision: 'rejected'` | 同上 | 同上 |
| T4 | `approved → stale` | 该 gate 依赖的任一上游步骤产出新的 `generationRevision` 或 `artifactDigest` 变化 | 已 `stale` 再触发不改写 | 之后引用该审批 → `WF_STATE_APPROVAL_STALE` |
| T5 | `rejected → pending` | 用户发起重画（提升 `generationRevision`） | 同 `(stepId, itemKey, generationRevision)` 只允许一次 | 未提升修订即提交 → `WF_REPLAY_GENERATION_REVISION_REQUIRED` |
| T6 | `rejected → awaiting_decision` | 重画产物通过结构校验 | 同 T1 | 同 T1 |
| T7 | `awaiting_decision → stale` | 等待期间上游变更（T4 的等待期版本） | 已 `stale` 再触发不改写 | 随后提交的审批 → `WF_STATE_APPROVAL_STALE` |
| T8 | `approved → approved` | **不存在** | — | 上游一变必然经 T4 到 `stale`，不允许"静默换绑定" |
| T9 | 任意 → `cancelled` | 用户取消整个 `WorkflowRun`（§10） | 已取消再触发无副作用 | — |

### 6.3 三个重复提交场景必须区分

| 场景 | 判定 | 结果 | 错误码 |
| --- | --- | --- | --- |
| 同一 `approvalId` + 同一 `decisionIdempotencyKey` + 同样内容 | 真重放 | **无副作用**，返回首次结果 | — |
| 同一 `approvalId` + 不同内容（换了 `decision` 或 `targetArtifactDigest`） | 同 ID 承载了两个决定 | **拒绝** | `WF_STATE_APPROVAL_DUPLICATE` |
| 不同 `approvalId` + `expectedStepRevision` 已过期 | 旧客户端在旧修订上做决定 | **拒绝**，**绝不静默接受** | `WF_STATE_APPROVAL_STALE` |
| `targetArtifactDigest` 指向的产物已不是当前产物 | 审批对象漂移 | **拒绝** | `WF_STATE_APPROVAL_TARGET_MISMATCH` |

`decisionIdempotencyKey` 由**客户端生成并持久化**，不是每次请求新生成
（`contracts.ts:582-584`）。

### 6.4 三个不同的事实（不可合并）

`s7_quality.threeDistinctFacts` 要求运行时始终能分别回答：

1. **生成成功** —— `Run.status === 'succeeded'`。
2. **结构校验通过** —— 产物能被 `STEP_OUTPUT_SCHEMAS` 解析，且
   `validateComicArtifacts()` 返回空错误码数组（`requiresStructuralValidation: true`）。
3. **人工批准** —— 存在有效 `ApprovalDecision`，绑定到具体 `assetId + version + contentDigest`。

**1 为真不代表 2 为真**（`retryPolicy.classification`：
"输出结构 / 业务校验失败 → `bounded_repair_then_fail`"，注："Run 成功不等于步骤成功"）。
**2 为真不代表 3 为真**（`qualityReportSchema` 的注释：
`structural.passed` 为 true 不代表用户认可画面）。

因此 `WorkflowStepRun.status` **必须**能同时表达"`Run` 成功了但结构校验没过"，
以及"结构校验过了但还没批"。`runIds` 非空而 `status = failed`、或
`artifactDigest` 存在而 `approvalId = null`，都是**合法且必须可表示的**组合。

**禁止**任何形式的自动通过。`g_assets.criticality` 明确写道：
"本步骤是角色一致性的唯一可信来源，**不可省略、不可自动通过**"。

审批对象**必须**锁定 `assetId + version + contentDigest`；
`mustNotBindTo: "画布上该节点当前显示的结果"`。
这正是 `apps/api/src/connected-image-results.ts:55` 的做法（取最近成功结果）
**不能**当作批准的运行时原因。

---

## 7. 等待人工的语义

权威表述：三个 gate 的 `waitingBehavior`
（`persistThenReleaseWorker: true`、`mustNotHoldPromiseWhileWaiting: true`、
`noNewVendorCallsWhileWaiting: true`、`approvalEventEffect: "idempotent_wakeup_only"`、
`mustNotMutateFrozenRuns: true`）。

### 7.1 五条硬规则

- **R7.1 必须持久化后释放执行资源。**
  进入 `awaiting_decision` 前，`WorkflowStepRun` 的
  `artifact` / `artifactDigest` / `revision` / `outputSchema` 必须已 commit。
  commit 之后 Worker **不得**继续占用执行槽位——不允许 long-poll、sleep 或
  await 一个人工事件。允许的形态只有"退出当前任务，等下一个事件唤醒"。
- **R7.2 不允许 Worker 长时间持有 Promise。**
  `mustNotHoldPromiseWhileWaiting: true`。任何 `await` 一个人工决定、
  或用定时器轮询审批表，都违反本条。判定方法：等待期间该 Worker 进程**可被安全杀死**，
  重启后链路能从持久化状态继续。
- **R7.3 批准事件只负责幂等唤醒后续调度。**
  `approvalEventEffect: "idempotent_wakeup_only"`。事件的唯一效果是
  "让调度器重新评估此 `WorkflowRun` 是否可推进"。
  同一事件重复投递必须**无副作用**。
- **R7.4 批准不得修改已冻结的旧 `Run`。**
  `mustNotMutateFrozenRuns: true`。批准改变的是
  `WorkflowStepRun.approvalId` 与后续步骤的**可派发性**，
  不是任何既有 `Run` 的快照、结果或 `idempotencyKey`。
- **R7.5 等待期间零新增生成调用。**
  `noNewVendorCallsWhileWaiting: true`。等待态的 `WorkflowRun`
  **不得**派发任何 `vendorCall: true` 的步骤，**包括**与本次等待无关的其他步骤。
  预算不得在等待期间被消耗。

### 7.2 三个 gate 的差异

| gate | `targetKind` | 候选选择 | 失效范围（`stalePolicy`） |
| --- | --- | --- | --- |
| `g_story` | `story_scope` | `allowCandidateSelection: false`（唯一允许不填 `selectedCandidateKey` 的情形） | `invalidate_this_gate_and_dependents_only`；`invalidateScope: steps_depending_on_changed_step` |
| `g_assets` | `asset_candidate` | `selectedCandidateKeyRequired: true`，`perItemApproval: true` | `invalidate_only_dependents_of_changed_itemKey`；`preserveOtherItemApprovals: true` |
| `g_final` | `page_render` | `allowCandidateSelection: true`，`perPageApproval: true` | `invalidate_this_gate_and_export_only`；`preservePanelApprovals: true` |

`g_story` 还有一个可选提前确认：`optionalEarlyConfirmation`
（`afterStep: "s1_premise"`、`enabledWhen: "brief 标记主题复杂"`、`default: false`）。
**默认关闭**；开启时它**不替代** `g_story`，只是一次额外的机会在更早的点止损。

---

## 8. 失效传播

目标：**上游修订后只使依赖该版本的下游与审批失效，保留不受影响步骤的已完成结果。**

### 8.1 判定规则

- **R8.1 失效的传播单位是三元组 `(stepId, itemKey, generationRevision)`**，
  不是"整个工作流"，也不是"整个步骤"。`g_assets.stalePolicy` 的
  `invalidate_only_dependents_of_changed_itemKey` 是本条的依据。
- **R8.2 依赖判定以 `inputBindings` 为准，逐条比对 `from`：**
  - `from` 指向**整步**（如 `"s2_script"`、`"s3_panel_plan"`）→ 该步骤**全部** `itemKey` 失效。
  - `from` 指向**子项**（如 `"s3_asset_manifest.items[].requirementPrompt"`、
    `"s5_render_specs.specs[]"`）→ **只有** `upstreamArtifactDigests` 里包含被改动摘要的
    那个 `itemKey` 失效。
  - `from` 是 `"workflow.input"` 或 `"s0_brief.*"` → 变更 `brief` 属于**换一次编排**
    （`briefDigest` 变化），不是失效，应新建 `WorkflowRun`。
- **R8.3 逐层传递但每层重新判定。** `s4_asset_candidates → g_assets → s5_render_specs
  → s6_panel_render → s7_quality → s8_layout → s8_render_pages → g_final → s9_export`
  是一条链，但第 2 层只应让"上游摘要真的变了"的那些子项失效，
  **不得**把所有下游无条件全量失效。
  例：`character:linwan@base` 重画 → `s5_render_specs` 里引用该 `itemKey` 的格失效，
  不引用它的格**保持 `succeeded`**；`s8_layout` 只重排受影响的页。
- **R8.4 不受影响的步骤保留全部已完成结果与既有 `Run`。**
  `preserveCompletedRunsOfUnaffectedSteps: true`、
  `preserveOtherItemApprovals: true`、`preservePanelApprovals: true`。
  **禁止**以"简单起见"整条重跑。
- **R8.5 失效不是删除。** `stale` 的 `WorkflowStepRun` 与其 `runIds` / `artifact` /
  `artifactDigest` **原样保留**，作为审计与"是否可复用"的证据。
  失效只改变它是否可作为下游输入。
- **R8.6 已批准但失效的资产不能再被引用。** 一旦 `g_assets` 对该 `itemKey` 的审批
  变为 `stale`，任何引用它的 `panelRenderSpecSchema.referenceAssetRefs`
  必须重新解析；解析失败的格不派发，并在下次校验时得到
  `WF_REF_ASSET_NOT_APPROVED` 或 `WF_REF_ASSET_VERSION_STALE`。
- **R8.7 `s8_layout` 的失效是重算，不是重画。** 它 `vendorCall: false` 且
  `isDeterministic: true`，失效后凭同一组输入重算必须得到**逐字节相同**的
  `page_layout`（因为排版坐标进指纹，也不含时间戳）。
  若重算结果不同，说明存在非确定性输入，属于缺陷而不是重试。

### 8.2 几个具体判定

| 事件 | 失效 | 保留 |
| --- | --- | --- |
| `s3_panel_plan` 增删一个格 | `s5_render_specs`、`s6_panel_render`、`s7_quality`、`s8_layout`、`s8_render_pages`、`g_final`、`s9_export`，以及 `g_story`（依赖 `s3_panel_plan`） | `s1_premise`、`s2_script` |
| `character:linwan@base` 重画（`s4` 某子项 `generationRevision +1`） | `g_assets` 中该 `itemKey` 的审批；引用它的 `s5_render_specs` 出来的格；这些格的下游 | 其他 `itemKey` 的候选与审批 |
| 仅 `s7_quality` 对某一格判 `rework` | `s6_panel_render` 的**该** `itemKey`；其下游 `s8_layout` / `s8_render_pages` / `g_final` / `s9_export` 中依赖该格的部分 | 其他格的候选；`g_assets` 的全部审批（`g_final.stalePolicy.preservePanelApprovals: true`） |
| 用户改 `artStyle.notes` | 属于 `brief` 变化 → **新建 `WorkflowRun`** | 旧编排原样保留 |

---

## 9. 迟到 / 过期回调

**明确选择：保留为审计记录 + 标记 `needs_review`。既不丢弃，也不采纳。**

### 9.1 判定

一个到达的 `Run` 结果属于"迟到/过期"，当且仅当下列任一项不成立：

| 比对项 | 与什么比 |
| --- | --- |
| `stepId` | 当前有效 `WorkflowStepRun` |
| `itemKey` | 同上 |
| `generationRevision` | 同上 |
| `inputFingerprint` | 同上 |
| `definitionDigest` | 同上 |

全部相等 → 正常验收（§6 T1）。
任一不等 → 迟到/过期，按下节处置。

### 9.2 处置规则

- **R9.1 结果与资产**：该 `Run` 行与其 `AssetVersion` **原样保留**，
  **绝不删除、绝不改写**。只以 `WorkflowStepRun.auditRunIds` 关联。
- **R9.2 不可采纳**：**不得**进入 `runIds`，**不得**写入 `artifact`，
  **不得**被任何下游 `inputBindings` 引用。任何试图引用它作上游的动作
  必须失败（`WF_REPLAY_FINGERPRINT_MISMATCH`，
  修订不符时为 `WF_STATE_STEP_REVISION_MISMATCH`）。
- **R9.3 标记**：受影响的 `WorkflowStepRun` 置 `needs_review` 并记录上述 `issueCode`。
  若该 `WorkflowRun` 已 `succeeded`，则置为 `needs_review` 而**不是**静默忽略。
- **R9.4 不自动重发**：迟到回调**不得**触发任何新的生成调用。
  它与 `sendUnknownPolicy.mustNotAutoResubmit: true` 同一条纪律。

### 9.3 为什么选"保留 + needs_review"而不是"丢弃"

1. **结果已经付过费。** 丢弃会同时丢掉成本归集与"这次到底拿到了什么"的审计证据。
   `budgetPolicy.counters` 要求 `vendorRequests` / `imageGenerations` 可结算，
   丢弃会让账实不符。
2. **自动采纳会静默替换已批准产物。** `g_assets.approvalPolicy.approvalBindsTo`
   是 `assetId + version + contentDigest`。让一个指纹不符的结果进入
   `runIds`，等价于在用户背后换掉被批准的版本——这正是
   `mustNotBindTo: "画布上该节点当前显示的结果"` 要防的事。
3. **迟到不必然是错误。** 最常见的成因是"用户点了再画一张，而上一轮的在途请求
   稍后才返回"。那个结果本身是**合法的、有成本的**，只是不再属于当前修订。
   它是"历史候选"，不是"垃圾"。
4. **`needs_review` 是既有语义，不需要发明新状态。**
   `workflow-definition.v1.json` 的 `sendUnknownPolicy.status = "needs_review"`
   已经确立了这个状态的含义："结果存在但归属不确定，必须人看"。
   重用它与 `WF_STATE_SEND_UNKNOWN` 一起构成一致的处置语言。
5. **"丢弃"是不可逆的，"保留"是可逆的。** 若事后发现指纹比对逻辑有误，
   保留的记录可以补救；删除的不能。

---

## 10. 取消

权威表述：`budgetPolicy.cancellationBehavior`
（`stopNewDispatch: true`、`preserveProducedResults: true`、
`mustNotPromiseAllInFlightCancelledOrRefunded: true`）。

### 10.1 三条规则

- **R10.1 停止新派发。** 取消后**不得**再为本次 `WorkflowRun` 创建任何
  `WorkflowStepRun` 的付费派发，也不得推进任何 `pending` 步骤。
  已在 `awaiting_decision` 的 gate 直接置 `cancelled`，不产生任何生成调用。
- **R10.2 保留已产生结果。** 已 `succeeded` 的 `WorkflowStepRun`、其 `artifact`、
  其 `Run` 与 `AssetVersion`（包括已付费的候选）**全部保留**。
  已完成的 `Run` **不被取消**——它的结果仍有价值（可作为候选或审计）。
- **R10.3 不承诺在途请求都能取消或退款。**
  `mustNotPromiseAllInFlightCancelledOrRefunded: true`。
  面向用户的文案**必须**写明这一点：取消 = "不再派发新的、保留已经产生的"，
  **不是**"全部停止并退钱"。
  已进入 `sending` 的 `RunSendIntent` 可能已经送达 vendor，
  中止它只影响本地状态，不影响平台侧副作用。

### 10.2 与"发送状态不确定"的关系

在途请求返回后若状态不确定，仍按 §12.2 处置：置 `needs_review` +
`WF_STATE_SEND_UNKNOWN`，**不得**自动重发——即使在取消之后。
取消**不**降低"重复付费"的风险等级。

---

## 11. 部分成功

`joinPolicy` 在四个 fanout 步骤上都是 `all_required`
（`s4_asset_candidates`、`s6_panel_render`、`s8_layout`、`s8_render_pages`），
且都是 `failFast: false` + `independentCheckpointPerItem: true`。

### 11.1 语义

`all_required` 是**全有或全无**的**交付**语义，**不是**"全有或全无的执行"语义。
两者必须分开：

| 层面 | 行为 |
| --- | --- |
| **执行** | 一个子项失败**不**取消其他子项。其他子项继续跑完并各自 checkpoint（`failFast: false`）。 |
| **保留** | 成功的子项：`status = succeeded`，`artifact` 落库，**不重跑**。 |
| **失败项** | 只有失败项进入重试/返工队列（`failureIsolation: "per_item"`）。 |
| **步骤整体** | 只要任一 `all_required` 子项未成功，该步骤整体 `status = failed`（**不是** `partial`）。 |
| **下游** | 下游步骤**不得开始**。`dependsOn` 未满足。 |
| **交付** | **完整交付仍被阻断**：`s9_export` 不产出，`comicExportManifestSchema` 不生成。 |
| **错误码** | 导出阶段的完整性拒绝用 `WF_EXPORT_INCOMPLETE`（`exportPolicy.rejectOnIncomplete: true`）。 |

### 11.2 四条规则

- **R11.1 保留成功子项、只处理失败项。**
  `retryPolicy.classification` 的"部分子项失败"条目原文：
  `action: "keep_succeeded_items_process_failed_only"`、
  `fullDeliveryStillBlocked: true`、`joinPolicy: "all_required"`。
  `s4_asset_candidates.foreach.note`："重跑一个角色不得重跑其他角色"；
  `s6_panel_render.foreach.note`："单格失败不得触发整篇重画"。
- **R11.2 重跑失败项**：`generationRevision` **提升 +1**（这是用户/系统主动重画，
  不是网络重试），旧产物保留（§5），消耗 `regenerationsPerItem`。
  若只是技术故障（无发送痕迹），则走 `attempt += 1` 或 `Run.retryOf`，
  **不**提升修订（§5、§7.1 R5.1）。
- **R11.3 并发上限受控**：`maxConcurrency` 为 `4`（`s4`、`s6`）与 `2`
  （`s8_layout`、`s8_render_pages`）；`s6_panel_render.concurrency` 要求
  `reuseExistingScheduler: true`（`apps/worker/src/generation-concurrency.ts`）、
  `mustNotAddSecondUnboundedScheduler: true`、
  `workflowLevelCeiling: true`、`fairnessAcrossWorkflowRuns: true`。
  **不得**为"部分成功重跑"开第二条无界队列。
- **R11.4 串行是例外**：`s6_panel_render.foreach.serializationRule`
  只在某格确实依赖前一格定稿图时才串行，其余走有界并行。
  不得为了省事把整个 fanout 串行化（会拖长等待并放大首项失败的影响）。

---

## 12. 事务边界

只有两个事务边界，边界之外**不得**产生付费副作用。

### 12.1 提交事务（一次付费派发）

**同一个事务内**完成以下六项，任一项失败即整体回滚：

| # | 操作 | 依据 |
| --- | --- | --- |
| 1 | `upsert` `WorkflowStepRun`（按 §2 唯一键；命中即**转恢复路径**，不新建） | §2.2 R2.1 |
| 2 | **原子预留预算** | `budgetPolicy.reservation: "atomic_reserve_before_dispatch"`；"禁止并发子项读到同一笔剩余额度" |
| 3 | 创建 `Run`，`idempotencyKey = submitIdempotencyKey(...)` | `contracts.ts:1070` |
| 4 | 创建 `ExecutionAuthorization` | `packages/execution/src/index.ts:184` |
| 5 | 创建 `RunSendIntent`（`status = 'pending'`） | `packages/execution/src/index.ts:297`；`prisma/schema.prisma:544` |
| 6 | 创建 Outbox 记录 | `apps/api/src/runs.ts:182` 路径 |

**为什么必须同事务**：任意一项单独成功都会留下不可自愈的中间态——
"有预算预留但没有授权"（钱占了，活没派）、"有授权但没有预算"（活派了，钱没占，
并发下超支）、"有 `Run` 但没有 `RunSendIntent`"（无法判断是否已发送，只能靠猜）。

**并发裁决**：`Run @@unique([projectId, idempotencyKey])`
（`prisma/schema.prisma:382`）是同一幂等键并发提交时的唯一裁决者。
两方同时提交时只有一方 commit 成功；另一方捕获唯一冲突后**必须**转入恢复路径，
**不得**换一个幂等键重试。

**预算耗尽**：计数不足时抛 `WF_BUDGET_EXCEEDED` 并回滚整个事务，
行为是 `stopNewDispatch: true` + `preserveInFlightAndCompleted: true`。
`amountBudget = null` 时**不得**显示为 0 成本
（`mustNotDisplayAsZeroCost: true`），报 `WF_BUDGET_UNKNOWN_PRICE`。

**结算**：`budgetPolicy.settlement: "on_terminal"`——`Run` 进入终态时才结算，
不在派发时结算。

### 12.2 恢复事务（进程重启 / 技术重试）

**只读 + 状态推进，不新建任何付费记录。**

必须读取（全部为**已持久化**内容）：

1. `WorkflowStepRun`（按 §2 唯一键）
2. 其 `runIds` / `auditRunIds`
3. 每个 `Run` 的 `idempotencyKey` / `status` / `attempt` / `retryOf`
4. 该 `Run` 的**冻结快照**（`requireFrozenNodeRequest` 语义）
5. `RunSendIntent.status`（唯一键 `@@unique([runId, nodeId, attempt])`，`prisma/schema.prisma:557`）

分流：

| 持久化状态 | 动作 | 错误码 |
| --- | --- | --- |
| `Run` 存在且 `idempotencyKey` 相同 | **复用**，绝不新建 | — |
| `Run` 已 `succeeded` 但结果未归档 | `recover_existing_result`，**不得重新生成** | — |
| `RunSendIntent.status !== 'pending'` | 置 `needs_review`，**不得自动重发、不得改幂等键** | `WF_STATE_SEND_UNKNOWN` |
| 原 `Run` 已有后继（`Run.retryOf` 指向它） | 该节点只能恢复已有结果或轮询 | `WF_STATE_SEND_UNKNOWN` |
| 确认无 `Run`、无 `RunSendIntent`、预留仍在 | **才**允许走 §12.1 提交事务 | — |

依据原文（`packages/execution/src/index.ts:737`）：

```ts
if (record.status !== 'pending') {
  throw new ExecutionError('send_requires_review', '原请求可能已经送达，禁止重复创建');
}
```

同文件 `:755-757` 进一步禁止"原任务已有后继重试"时再次创建请求。

### 12.3 为什么发送状态不确定时禁止自动新建

1. **"不确定"意味着请求可能已经送达。** 平台侧副作用不可撤销。
   自动新建 = 明知可能重复还重复，这是**二次付费**，不是"重试"。
2. **`Run @@unique` 挡不住换键重发。** 该约束只在 `(projectId, idempotencyKey)`
   相同时生效。只要新建时算出**不同的**幂等键，约束完全不起作用——
   而这正是最危险的情形：它看起来"成功创建了一个新 `Run`"，账面上毫无异常。
3. **旧记录仍可能被迟到轮询写回。** 原 `Run` 的在途请求返回后会写结果；
   新建的 `Run` 也会写结果。两者都认领同一个 `(stepId, itemKey)`，
   于是"当前有效产物"取决于到达顺序——这是无法通过重试收敛的状态。
4. **人工判断是唯一可靠的出口。** `needs_review` 把决策交给人：
   先去平台侧核对这次请求到底有没有送达，再决定复用还是重发。
   `mustNotChangeIdempotencyKey: true` 保证重发时仍是那一次的逻辑身份。
5. **恢复必须读持久化记录，不得读实时画布。** §4.4 已论证：
   读实时画布会得到不同的 `normalizedInputs` → 不同指纹 → 不同幂等键 →
   绕过第 2 点所述的全部防线。这是"禁止自动新建"与"必须读冻结快照"
   必须成对出现的原因。

---

## 附：一页速查

| 问题 | 答案 | 出处 |
| --- | --- | --- |
| 三层是什么 | `WorkflowRun` └ `WorkflowStepRun` └ 0..N `Run` | §1 |
| 步骤身份键 | `(workflowRunId, stepId, itemKey, generationRevision)` | §2 |
| 指纹怎么算 | 规范 JSON → 注入的 hasher；对象键排序、丢 `undefined`、数组保序、不规范化数值 | §3.3 |
| 幂等键最长 | ≤ 178（上限 200） | §4.2 |
| "再画一张" | 提升 `generationRevision`，即使提示词未变 | §5 |
| 网络失败 | 保留 `generationRevision`，走 `attempt` / `Run.retryOf` | §5 |
| 审批过期 | `WF_STATE_APPROVAL_STALE`，绝不静默接受 | §6.2 |
| 等待人工 | 先持久化再释放 Worker，事件只做幂等唤醒 | §7 |
| 上游改了 | 只失效依赖该版本的子项，保留其余 | §8 |
| 迟到结果 | 保留 + `needs_review`，不采纳不删除 | §9 |
| 取消 | 停止新派发、保留已产生、不承诺全取消不退款 | §10 |
| 部分失败 | 保留成功项、只重跑失败项、交付仍阻断 | §11 |
| 发送不确定 | 禁止自动新建，置 `WF_STATE_SEND_UNKNOWN` | §12.3 |

