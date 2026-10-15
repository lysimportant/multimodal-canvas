# topic-to-comic@0.1.0 —— 一句主题 → 分页漫画（P1 草案说明）

> **状态：草案（DRAFT）。** 本目录位于 `docs/` 下，不被 `apps/*` 或 `packages/*` 导入。
> 唯一事实来源是同目录的 `contracts.ts`（Zod 契约，含稳定错误码）与
> `workflow-definition.v1.json`（步骤、gate、foreach、策略）。本 README 只做导读，
> **不新增、不修改任何字段语义**；两者冲突时以那两份文件为准，并按下文第 9 节记录差异。

---

## 1. 用户目标

用户给**一句大概主题**（例：「雨夜里，修伞匠等一个不会回来的人」），AI 完成一系列动作，
产出一份**分页漫画**：分页的页图 + 格矩形 + 对白气泡与旁白排版 + 最终入选图片版本清单。

首版形态明确为**分页漫画**（`workflow-definition.v1.json` 的 `"form": "paged-comic"`）。
**不同时承诺条漫与视频**：条漫是另一种版面模型（无限画布、连续滚动、无固定页边界），
视频是另一种产物（时间轴、时长、运镜），三者的"成品"契约不同。同时承诺会让我们
在任何一次评审里都无法对"成品到底长什么样"达成一致。形态一旦定死，`formNonGoals`
（第 3 节）就是它的代价清单，而不是免责声明。

---

## 2. 首版范围

**验收规模：1 页 / 4 格 / 最多 2 个主要角色 / 1 个主要场景。**

| 维度 | 首版验收值 | 契约上限（`contracts.ts`） |
| --- | --- | --- |
| 页数 | 1 | `productionLimitsSchema.maxPages` ≤ 200 |
| 每页格数 | 4 | `productionLimitsSchema.maxPanelsPerPage` ≤ 24 |
| 主要角色 | 2 | `productionLimitsSchema.maxCharacters` ≤ 200 |
| 主要场景 | 1 | `productionLimitsSchema.maxScenes` ≤ 200 |

**这是验证规模，不是永久产品限制。** 理由：首版要验证的是**链路正确性**，即
「生成成功 ≠ 结构校验通过 ≠ 人工批准」这三件事是否被真实区分、失效是否只传播到该传播的地方、
重画一张是否只重画一张。这些性质与规模无关，但规模越大，验证一次的成本和噪声越高。
1 页 4 格刚好能暴露全部关键路径（1 次 fanout 展开、1 个 gate、1 次排版、1 次导出），
同时在 4 格规模下跑一轮真实闭环的成本可以接受。

契约本身**不**为首版把上限调小：上限是安全边界，不是产品形态。首版只是选择在这个边界内
用一个小得多的规模做验收。

**题材由输入决定，不默认仙侠。** `comicBriefSchema.genre` 是**无默认值的必填字符串**
（`contracts.ts:313`，刻意不用 `z.enum`）：现有 `screenplay-xianxia` 等 Skill 是题材模板，
不是题材全集；把题材做成闭集会在第一次遇到新题材时要求改契约。
`screenplay-xianxia` 仅在 `brief.genre` 明确为仙侠且用户选择时使用
（`workflow-definition.v1.json` `s2_script.outputContract.genreSpecificSkillRule`）。

---

## 3. 非目标

以下照抄 `workflow-definition.v1.json` 的 `formNonGoals`：

- 条漫 / 竖屏滚动漫画
- 动画或视频输出
- 跨作品连续剧集
- 多语言本地化排版

补充一条工程非目标（来自 `workflow-definition.v1.json` `runtimeReferences`）：
**不重写底层执行器。** 短视频复刻保留为另一份模板
（`packages/domain/src/video-recreation.ts:169`），复用其来源追溯与版本绑定机制，
但**不**并入本工作流。

---

## 4. 当前代码复用点

原则：能复用的**一律复用**，本方案只新增"漫画生产链路的产物契约"，
即现有领域包里不存在的那一层。

| 契约 / 机制 | 真实文件:行 | 本方案如何使用 |
| --- | --- | --- |
| `canvasDocumentSchema` | `packages/domain/src/index.ts:1074` | 画布文档的唯一合法形态。投影写回仍走它，**不新增第二套画布 schema**。（其 `superRefine` 在 `:1127` 调用连线判据。） |
| `canvasNodeSchema` | `packages/domain/src/index.ts:1010` | 每个 `itemKey` / `panel:{panelId}` / `page:{pageId}` 对应一个**稳定**节点；身份由 key 承载，不靠 `position`。 |
| `canvasEdgeSchema` | `packages/domain/src/index.ts:1038` | 投影只增加既有语义的边，不引入"漫画专用"的第二种边。 |
| `canvasGroupSchema` | `packages/domain/src/index.ts:1062` | 一页的四格可作为分组折叠展示；分组是展示，**不进指纹**。 |
| `isPortConnectionAllowed` | `packages/domain/src/index.ts:2009`（`:1127` 是它在 `canvasDocumentSchema` 内的调用点） | **连线兼容性的唯一判据**（`workflow-definition.v1.json` `canvasProjectionPolicy.portCompatibility.mustReuse`）。投影层不得自建端口白名单。 |
| `promptDocumentSchema` 正文 20,000 字符上限 | `packages/domain/src/index.ts:300`，上限判定在 `:330` | 步骤产物落到文本节点正文时沿用同一条上限；`s5_render_specs.compilationRules.promptCharLimit = 20000` 与 `promptCharLimitRef` 指向同一处。 |
| `runSnapshotSchema` | `packages/domain/src/index.ts:1304` | 每个 `WorkflowStepRun` 派发的 `Run` 仍使用现有快照；步骤层不另存一份快照格式。 |
| `runSnapshotFingerprintMaterial` | `packages/domain/src/index.ts:1537` | **实现参照**：递归键排序 + 数组保序（`stableSnapshot` 在 `:1528`）。只借鉴算法，**不改变其授权身份语义**。 |
| `workflowStateSchema` | `packages/domain/src/index.ts:1620` | Worker 拓扑执行的既有状态载体；`WorkflowRun` 是它**之上**的外层编排状态，不替换它。 |
| `Run @@unique([projectId, idempotencyKey])` | `prisma/schema.prisma:382` | 提交幂等键的**最终防线**：同一 `(projectId, 幂等键)` 只可能有一个 `Run`。 |
| `Run.retryOf` | `prisma/schema.prisma:370` | 技术重试沿用既有重试链；不新建"重试表"。 |
| `Run.idempotencyKey` 上限 200 | `packages/domain/src/index.ts:1651` | `submitIdempotencyKey` 的长度预算上限（见 `runtime-semantics.md` §4）。 |
| `AssetVersion` 与 `@@unique([assetId, version])` | `prisma/schema.prisma:317` / `:330`（`sha256` 可空见 `:322`） | 候选资产版本；`ApprovedAssetRef.version` 指向它。`sha256` 可空正是 `contentDigest` / `digestSource` 必须显式记录来源的原因（`contracts.ts` D5）。 |
| `EXPORT_SCHEMA_VERSION` | `apps/api/src/export.ts:7` | 值同为 `1` 但**语义不同**：`comic_export_manifest` 刻意不复用它，避免两者回滚互相牵连。 |
| `executableNodeIds` | `packages/execution/src/index.ts:75` | 只过滤禁用与来源节点并返回授权 ID —— **它不是执行器**（`notAnExecutor`），别当执行器用。 |
| 发送防重 | `packages/execution/src/index.ts:737` | `if (record.status !== 'pending') throw new ExecutionError('send_requires_review', '原请求可能已经送达，禁止重复创建')`。发送状态不确定时**禁止自动新建**，见 `runtime-semantics.md` §12。 |
| Worker 拓扑执行 | `apps/worker/src/workflow-dag.ts:30`（`workflowExecutionOrder`） | `Run` 已包含目标节点及其上游依赖闭包；**不重写底层执行器**。 |
| 并发调度 | `apps/worker/src/generation-concurrency.ts:21`（`startWorkerConcurrencySync`，函数定义在 `:27`） | 复用既有全局并发上限；本方案只加**工作流级天花板与跨工作流公平性**，不新增第二个无界调度器。 |
| `PromptSkill` 是优化器不是生成器 | `packages/domain/src/prompt-skills.ts:62` 与 `:532` | 产出的是"给下游模型的更好指令"，不是成品（`:532`：`Return an improved instruction for the downstream model, not the finished story, script, analysis, image or video`）。只能挂在 `optionalPromptSkill` 上，默认 `off`。 |
| 资源提及能力检查当前直接放行 | `apps/api/src/resource-mention-capabilities.ts:74` | `checkResourceMentionCapabilities` 目前恒返回 `{ issues: [], simulated: ... }`。**不能依赖它**兜住"把未批准候选当参考图"。 |
| 最近成功结果不等于已批准 | `apps/api/src/connected-image-results.ts:55` | 取 `status === 'succeeded'` 并按 `createdAt` 倒序的第一个 = "最近成功"，**不是**"人工批准"。`ApprovedAssetRef` 必须来自 `ApprovalDecision`。 |
| 上游提示词可当正文 | `apps/api/src/connected-text-inputs.ts:63`（`:87` `data.prompt = text`） | 无结果时把上游节点正文直接当本节点正文。这正是契约必须显式区分 `literal_text` / `generated_artifact` / `approved_artifact` 的原因（`contracts.ts` D4）。 |
| 409 后重发旧整图 | `apps/web/src/App.tsx:1877`（`saveCanvas`）与 `:1895`（`if (response.status === 409)`） | 冲突后刷新服务器 revision 并重发**同一份快照**，会覆盖后台新建节点。投影写回必须改成带 `expectedRevision` 的批量命令。 |
| 画布覆盖式更新 | `apps/api/src/projects.ts:794` | `canvasEdge.deleteMany` + `:795 canvasNode.deleteMany` 后整体重建 = **覆盖式**写入。工作流投影**不得**走这条路径。 |

---

## 5. 新增能力边界

**不重写底层执行器。** 一次生成仍然是一次现有 `Run`：同一个快照格式
（`runSnapshotSchema`）、同一套授权与发送栅栏（`ExecutionAuthorization` /
`RunSendIntent` / `Outbox`）、同一条重试链（`Run.retryOf`）、同一个并发调度器
（`generation-concurrency.ts`）。本方案**不**给 Worker 加第二条执行路径。

真正新增的是**业务编排层**，只有三件事是现有代码里没有的：

1. **跨多个冻结 `Run` 的编排。** 一条漫画链路会派发 8 个 `vendorCall: true` 的步骤
   （`s1_premise`、`s2_script`、`s3_panel_plan`、`s3_asset_manifest`、
   `s4_asset_candidates`、`s6_panel_render`、`s7_quality`、`s8_render_pages`），
   每次派发都是一个独立 `Run`。现有代码没有"这些 Run 合起来算不算一个业务单元"的概念。
   → 新增 `WorkflowRun` / `WorkflowStepRun`。
2. **人工等待跨越进程生命周期。** 三个 gate（`g_story`、`g_assets`、`g_final`）
   要求"持久化后释放执行资源"，等待期间零新增生成调用。现有代码的等待都发生在一次
   Worker 任务内部。
   → 新增 `ApprovalDecision` 与审批状态机（`runtime-semantics.md` §6、§7）。
3. **动态展开的 foreach。** `s4_asset_candidates` 的展开集来自**上游生成产物**
   （`s3_asset_manifest.items`），运行时才知道有几个子项；每个子项要独立 checkpoint、
   独立失败隔离、独立重跑。
   → 新增带 `itemKey` / `generationRevision` 的子项身份模型（`runtime-semantics.md` §2）。

**明确不新增**：新的画布 schema、新的快照格式、新的执行器、新的并发队列、
新的发送幂等机制、"重试表"。凡是上表列出的机制，一律复用。

---

## 6. 本目录文件索引

| # | 文件 | 用途 | 状态 |
| --- | --- | --- | --- |
| 1 | `README.md` | 本文：目标、范围、非目标、复用点、能力边界、验收入口、迁移计划 | ✅ 本阶段产出 |
| 2 | `workflow-definition.v1.json` | **权威**：15 个步骤（`s0_brief` … `s9_export`）、3 个 gate、4 处 foreach、重试/预算/投影/导出策略、`definitionDigestInputs` | ✅ 已存在 |
| 3 | `contracts.ts` | **权威**：Zod 契约（`comicBriefSchema` … `comicExportManifestSchema`）、稳定错误码 `WORKFLOW_ISSUE_CODES`、`validateComicArtifacts()`、指纹与幂等键函数 | ✅ 已存在 |
| 4 | `task-templates.v1.json` | `generate` / `fanout` 步骤引用的任务模板正文；每个模板单独取 sha256 作为 `inputFingerprintMaterial.taskTemplateDigest` | ✅ 已存在 |
| 5 | `runtime-semantics.md` | 三层模型、唯一键、两层指纹、幂等键、重画 vs 重试、审批状态机、等待/失效/迟到/取消/部分成功/事务边界 | ✅ 本阶段产出 |
| 6 | `model-budget-matrix.md` | 每个步骤的 `budgetClass`（`text` / `image` / `vision`）与模型别名的对应矩阵；`vision` 缺失即跳过评审 | ✅ 已存在 |
| 7 | `fixtures/huozhai-s01/source-map.json` | 样例「货斋 S01」的输入到步骤的映射（哪个字段进哪个 `inputBindings.to`） | ✅ 已存在 |
| 8 | `fixtures/huozhai-s01/input.json` | 样例输入：合法的 `comicBrief`（主题/题材/画风/篇幅/预算/模型绑定） | ✅ 已存在 |
| 9 | `fixtures/huozhai-s01/expected-artifacts.json` | 样例的期望产物链，供 `validateComicArtifacts()` 正向通过 | ✅ 已存在 |
| 10 | `fixtures/theme-mini/input.json` | 最小输入样例（1 页 / 4 格 / 2 角色 / 1 场景，即第 2 节验收规模） | ✅ 已存在 |
| 11 | `fixtures/theme-mini/expected-artifacts.json` | 最小样例的期望产物链 | ✅ 已存在 |
| 12 | `fixtures/recovery-cases.json` | 负样例集：每条给出"输入 + **指定**错误码"，用于证明错误码可被 `workflowIssueCodesOf()` 提取 | ⏳ 待补 |
| 13 | `acceptance-matrix.md` | 验收矩阵：`WORKFLOW_ISSUE_CODES` 中的每一个码 → 由哪个 fixture / 哪条转场覆盖 | ⏳ 待补 |

---

## 7. 四阶段验收入口

每阶段的完成标志必须是**一条可执行、可复现、会失败**的命令或断言，不是"评审通过"。

### P1 契约与样例定标

**完成标志：** 存在一条命令，对 `fixtures/**/expected-artifacts.json` 全部运行
`validateComicArtifacts()` 得到**空错误码数组**，并对 `fixtures/recovery-cases.json`
里每条负样例得到**指定**的错误码（不多不少）；`STEP_OUTPUT_SCHEMAS` 的 12 个键与
`workflow-definition.v1.json` 中所有 `outputSchema` 值**双向命中**。

### P2 Mock 持久化纵切

**完成标志：** 在 Mock provider 下，对 `fixtures/theme-mini/input.json` 跑通一次完整
`WorkflowRun`：产生 1 个 `WorkflowStepRun`/页、4 个/格、2 个/角色资产、1 个/场景资产；
**零真实付费请求**；三个 gate 都停成 `awaiting_decision` 且此时进程退出后**重启能把链路接着跑完**。

### P3 小规模真实闭环

**完成标志：** 用真实 provider 对第 2 节规模跑通一轮，产出 `comic_export_manifest`
（含 1 页、`excludedPanels` 为空、`definitionVersion === "0.1.0"`）；
且可复现地证明三个 gate 的负例：陈旧审批被拒（`WF_STATE_APPROVAL_STALE`）、
目标不符被拒（`WF_STATE_APPROVAL_TARGET_MISMATCH`）、重复审批无副作用。

### P4 产品化与扩展

**完成标志：** 在**不改动** `contracts.ts` 任何既有字段语义的前提下，
把验收规模从 1 页放大到 N 页（N > 1，走同一份 `define`）并跑通；
同时新增一种题材（非仙侠）不需要改契约——即 `genre` 新值只出现在输入里，
`CONTRACT_SCHEMA_VERSION` 保持 `1`。

---

## 8. 迁移计划

**本目录是草案。** 在 P1 验收通过、且 `fixtures/` 与 `acceptance-matrix.md` 齐备之前，
不产生任何对 `apps/` / `packages/` / `prisma/` 的改动。

评审通过后按以下顺序迁移，每步都可独立回滚：

1. **契约落地。** `contracts.ts` 整体迁入 `packages/domain/src/workflow/`
   （建议 `contracts.ts` + `index.ts` 桶文件）。迁移要求：导出面与文件内符号名**逐字不变**；
   仍然只依赖 `zod`（与 `packages/domain` 一致的 `^3.24.2`），
   **不得**在契约模块里 `import 'node:crypto'` —— 哈希由调用方注入
   （`contracts.ts` D3），否则会污染 web 侧构建。
   理由：`packages/domain/src/index.ts` 是 2532 行的单文件，画布、运行快照、
   提示词文档全在里面；先在同构草案里把正/负样例跑通，再决定拆分边界。
2. **持久化落地。** 在 `prisma/schema.prisma` 增加：
   - `WorkflowRun`：一次业务编排（`definitionId` / `definitionVersion` / `definitionDigest` /
     `briefDigest` / `projectId` / 预算预留状态 / 状态 / `revision`）。
   - `WorkflowStepRun`：逻辑步骤或展开后的子项，
     唯一键 `@@unique([workflowRunId, stepId, itemKey, generationRevision])`（见 `runtime-semantics.md` §2）。
   - `ApprovalDecision`：`approvalId` + `decisionIdempotencyKey` 唯一，
     记录 `expectedStepRevision` 与 `targetArtifactDigest`。
   **`Run` / `AssetVersion` / `Project` 的既有列与既有唯一约束一律不改**，
   `WorkflowStepRun` 通过外键指向 `Run.id`，不复制 `Run` 的字段。
3. **投影接入。** 画布写回从覆盖式（`apps/api/src/projects.ts:794`）切换到
   `canvasProjectionPolicy.writePath` 要求的"带 `expectedRevision` 的批量画布命令"，
   `stable_node_per_item` 生效（同一次重试不新建节点）。
4. **执行接入。** 每一步的付费派发必须走既有受理路径
   （`ExecutionAuthorization` / `RunSendIntent` / `Outbox`，参照
   `packages/execution/src/index.ts:184` / `:297` / `:737`），
   **不得**绕过幂等直接调用 vendor。
5. **导出对齐。** `comic_export_manifest` 保持独立于
   `EXPORT_SCHEMA_VERSION`（`apps/api/src/export.ts:7`）；`exportPolicy.notSufficientForDelivery`
   列出的四项（工作流 JSON、结果文件列表、`manifest.json`、资产 ZIP）**单独出现时不构成交付**。

---

## 9. 已知的与两份权威文件不一致之处

写作过程中发现下列锚点/规则不一致。**本阶段不修改** `contracts.ts` 与
`workflow-definition.v1.json`，仅在此登记，供评审处理：

| # | 位置 | 问题 | 建议 |
| --- | --- | --- | --- |
| 1 | `contracts.ts:24`、`workflow-definition.v1.json` `canvasProjectionPolicy.portCompatibility.ref` | 两处都把 `isPortConnectionAllowed` 标为 `packages/domain/src/index.ts:1127`，但 `:1127` 只是它在 `canvasDocumentSchema` 内的**调用点**，**定义在 `:2009`** | 改为 `:2009`（或写 `:2009`，定义 / `:1127`，调用点） |
| 2 | `contracts.ts:25` | `promptDocumentSchema` 标为 `packages/domain/src/index.ts:305`，实际定义在 `:300`；`:305` 是 `.strip()`。`:330` 的 20,000 上限引用是**正确**的 | 改为 `:300`（上限仍指 `:330`） |
| 3 | `workflow-definition.v1.json` `taskTemplates.requiredForStepTypes` | 只声明 `["generate"]`，但三个 `type: "fanout"` 且 `vendorCall: true` 的步骤（`s4_asset_candidates`、`s6_panel_render`、`s8_render_pages`）都声明了 `taskTemplate`。若运行期严格按该列表只对 `generate` 求 `taskTemplateDigest`，这三个步骤的模板正文会**不进指纹** | 改为 `["generate", "fanout"]`，或明确 fanout 复用所属 `generate` 语义 |
| 4 | `contracts.ts:1070-1088` `submitIdempotencyKey` | （a）折叠触发条件是整串 `definitionId\|stepId\|itemKey` 超 80 字符，因此长 `stepId` 也会让**短** `itemKey` 被折叠，与注释"长 itemKey 走摘要折叠"不符；（b）折叠用 32 位非加密 `simpleHash`，两个不同 `itemKey` 可能折叠到同一值，随后在 `Run @@unique([projectId, idempotencyKey])`（`prisma/schema.prisma:382`）上被当成同一次提交，**静默去重一个不同的付费子项**；（c）超长时 `throw new Error('WF_REPLAY_KEY_TOO_LONG')` 抛的是裸 `Error` 而非 `workflowIssue(...)`，因此 `workflowIssueCodesOf()`（`contracts.ts:200`）无法提取该码，与 D1"所有校验错误都带 `params.workflowIssueCode`"相矛盾 | 折叠时保留 `itemKey` 摘要的独立段并对命中做"五项等值断言"（见 `runtime-semantics.md` §4）；超长改抛 `workflowIssue('WF_REPLAY_KEY_TOO_LONG', ...)` |
| 5 | `contracts.ts:674-706` `qualityReportSchema` vs `workflow-definition.v1.json` `s7_quality.reworkPolicy` | `reworkPolicy` 要求 `increment_generation_revision_for_itemKey`、并按 `budget.maxRegenerationsPerItem` 计数，但 `qualityReportSchema` 只有 `structural.*` 与 `manual.verdict`（且 `manual` 可为 `null`），**没有**任何字段能表达"哪个 `itemKey` 要提升修订"或"这是第几轮返工"。`WF_REPLAY_GENERATION_REVISION_REQUIRED` 因此没有产生者 | 在产物契约或独立的返工决策记录里补 `reworkTargets: { itemKey, nextGenerationRevision, round }[]` |
| 6 | `contracts.ts:572` `approvalDecisionSchema.targetKind` 与 `workflow-definition.v1.json` | `targetKind` 枚举含 `panel_candidate`，但 15 个步骤里的 3 个 gate（`g_story`=`story_scope`、`g_assets`=`asset_candidate`、`g_final`=`page_render`）**没有**任何 gate 使用它；`s6_panel_render` 产出 `panel_candidate_set` 却无对应 gate，`s8_layout` 直接依赖 `s7_quality` | 要么为格候选补 gate，要么从枚举移除，二者取一 |
| 7 | `contracts.ts:853-995` `validateComicArtifacts` | 入参只覆盖 `renderSpecs` / `layouts`，**不含** `panelCandidateSet` / `renderedPageSet` / `qualityReport`，因此"格候选被换过版本"这类陈旧无法被这个校验器发现；`pageLayoutSchema.balloons[].readingIndex`（`contracts.ts:763`）也从未被校验，`WF_LAYOUT_READING_ORDER_INVALID` 只覆盖 `panelPlan` 的 `ordinal` | P1 内补入参与校验，或显式声明该函数的作用域不含这三者 |
| 8 | `workflow-definition.v1.json` `definitionDigestInputs` | 清单**不含** `form`（`"paged-comic"`）与 `formNonGoals`。即把形态从分页漫画改成条漫、或删掉一条非目标，`definitionDigest` **不变**，已存在的 `WorkflowRun` 不会被判定为定义已变，会继续按新定义被解析。而 `form` 恰恰是"唯一事实来源"里定义"成品长什么样"的字段 | 若形态是产品决策而非契约，请写明；否则把 `form` 与 `formNonGoals` 加入 `definitionDigestInputs` |

