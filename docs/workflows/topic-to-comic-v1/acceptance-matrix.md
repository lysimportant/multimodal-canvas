# topic-to-comic@0.1.0 —— 验收矩阵、错误码覆盖与失败矩阵（P1 阶段产出）

> 本文档是 P1（契约与样例定标）的验收映射，回答一个问题：**每一条需求，由哪一条契约、哪一段现有代码兜底，缺哪一条测试；每一个错误码，由哪个夹具或哪条恢复场景证明它真的会发生。**
> 数据侧配套文件：`fixtures/recovery-cases.json`（12 条「事件序列 → 期望状态」恢复场景，P2 测试的输入）。本文档只做映射与判定，不改动任何行为。

---

## 0. 方法、约束与行号约定

- **写入范围**：本次只在本目录（`docs/workflows/topic-to-comic-v1/`）内新增 `fixtures/recovery-cases.json` 与本文档；未修改 `apps/`、`packages/`、`prisma/` 下任何文件，也未修改本目录内他人已有的 `contracts.ts`、`workflow-definition.v1.json`、`runtime-semantics.md`、`README.md`、`task-templates.v1.json`、`model-budget-matrix.md`、`FINDINGS-p1.md` 与既有 fixtures。
- **三份权威文件**（本表一切 step id / 错误码 / 字段名与它们逐字一致）：
  - `contracts.ts` —— `CONTRACT_SCHEMA_VERSION = 1`（`contracts.ts:75`）；`WORKFLOW_ISSUE_CODES` 共 **35 个码**（`contracts.ts:121-172`）；12 个产出 schema 的集合 `STEP_OUTPUT_SCHEMAS`（`contracts.ts:1111`）；`validateComicArtifacts()`（`contracts.ts:855`）。
  - `workflow-definition.v1.json` —— 15 个 step（12 个产出步 + 3 个 gate）、`retryPolicy.classification`（`:647-683`）、`budgetPolicy`（`:686-716`）、`canvasProjectionPolicy`（`:718-746`）、`exportPolicy`（`:748-773`）。
  - `runtime-semantics.md` —— 三层关系（`:19-107`）、唯一键（`:108-159`）、审批状态机（`:357-421`）、等待人工（`:423-466`）、失效传播（`:468-516`）、迟到回调（`:517-567`）、取消（`:570-597`）。
- **行号约定**：`文件:行` 均为本文档编写时的实测值。**注意：本目录多个文件由协作者并行编辑，行号会漂移**——编写期间 `contracts.ts` 的 `validateComicArtifacts()` 之后整体后移 2 行（`:853→:855`，产出点 `:872→:874`、`:957→:959`、`:1070→:1072`），`fixtures/huozhai-s01/expected-artifacts.json` 的行号整体后移 34 行。**引用时以 `grep` 现测为准**；错误码名与字段名不受影响，是稳定锚点。
- **术语**：`stepRun` = `WorkflowStepRun` 行；`Run` = 既有 `Run`（`prisma/schema.prisma:356`）；`供应商创建请求数` = 真正到达供应商 POST 的请求数（本地被拒绝的尝试不计入）。

---

## 1. 总表：需求 → 契约 → 现有模块 → 待加测试

需求项取自 `README.md` §1 用户目标与 §5 新增能力边界，能力项取自 `workflow-definition.v1.json` 的 15 个 step（S0–S9 + 3 个 gate + 2 条横切）。「现有模块」只列真实存在的 `文件:行`；「待加测试」是 P2/P3 应新建的文件与断言，**P1 不创建它们**。

| 需求 | 契约（contracts.ts 的 schema 或错误码） | 现有模块（真实文件:行） | 待加测试（文件名 + 断言） |
|---|---|---|---|
| **S0 主题 → 归一化 brief 与预检**（`s0_brief`，transform，`vendorCall:false`，`retryPolicy.mode:none`） | `comicBriefSchema`（`contracts.ts:303-347`）；预算 `budgetPolicySchema`（`:270-289`，`amountBudget` 可 `.nullable()` `:284-287`）；预检码 `WF_INPUT_INVALID` / `WF_MODEL_BINDING_MISSING` / `WF_LIMIT_CHARACTERS`（`workflow-definition.v1.json:61`） | `apps/api/src/runs.ts:182`（既有拓扑执行入口）；`packages/domain/src/index.ts:300`（`promptDocumentSchema`） | `apps/worker/src/workflow-definition-contract.test.ts`：三码各一条负样例；`amountBudget:null` 时不得按 0 成本记账 |
| **S1 故事前提**（`s1_premise`，generate，`vendorCall:true`，`budgetClass:text` `:74`，taskTemplate `comic-premise.v1`，`maxAttempts:2` `:92`） | `storyPremiseSchema`（`:355-377`）；`STEP_OUTPUT_SCHEMAS.story_premise`（`:1111`） | `packages/domain/src/prompt-skills.ts:62`、`:532`（PromptSkill 是提示词优化器，不是内容生成器）；`packages/execution/src/index.ts:297` | `apps/worker/src/workflow-recovery.test.ts`：s1 产生恰好 1 个 Run；缺 `modelBindings` 时不派发 |
| **S2 剧本与对白**（`s2_script`，`budgetClass:text`，`stableIdsRequired: characterId/dialogueId/beatId/sceneId` `:118`） | `comicScriptSchema`（`:379-412`）；`stableIdSchema`（`:85`）；`literalTextRefSchema`（`:220`）；`WF_REF_UNKNOWN_SPEAKER` 产出点 `:896` | `contracts.ts:896`；`apps/api/src/connected-text-inputs.ts:63`（把上游提示词当正文的风险点） | `workflow-definition-contract.test.ts`：每条 `dialogue.speakerCharacterId` 都能在 premise 角色集中解析；负样例只返回 `WF_REF_UNKNOWN_SPEAKER` |
| **S3 分格计划与资产清单**（`s3_panel_plan` `:126`、`s3_asset_manifest` `:164`，均 `budgetClass:text`） | `panelPlanSchema`（`:452`）；`assetManifestSchema`（`:491`）；`assetItemKeySchema`（`:465-470`）；`WF_LIMIT_PAGES`、`WF_LIMIT_PANELS` 产出点 `:911`、`:913` | `workflow-definition.v1.json:156`（forbiddenFields）、`:190-192`（`itemKeyFormat <kind>:<entityId>@<variantId>`，禁数组下标/中文/空格） | `workflow-definition-contract.test.ts`：itemKey 语法负样例；每格恰好一个 ordinal；`WF_LIMIT_PAGES` / `WF_LIMIT_PANELS` 各一条 |
| **S4 角色与场景候选（foreach 付费扇出）**（`s4_asset_candidates`，`budgetClass:image` `:254`，`hardCap:500`、`maxConcurrency:4`、`failFast:false`、`independentCheckpointPerItem:true` `:257-270`） | `assetCandidateSetSchema`（`:529-549`）；`approvedArtifactRefSchema`（`:244-253`）；`generatedArtifactRefSchema`（`:231-243`） | `packages/execution/src/index.ts:184`（受理事务 + advisory lock）、`:297`（ExecutionAuthorization 创建）、`:737`（非 pending 意图拒绝再次创建）；`apps/worker/src/generation-concurrency.ts:21`（复用既有并发闸门，禁止第二套无界调度） | `apps/worker/src/workflow-recovery.test.ts`：3 个子项 = 3 个 Run；重跑一个角色不得重跑其他角色（`_fixture.baselineCounts`） |
| **g_story 故事门**（gate，`targetKind:story_scope`，`allowCandidateSelection:false` `:199-231`） | `approvalDecisionSchema`（`:561-612`），`expectedStepRevision`（`:570`）、`targetKind`（`:572`）、`decisionIdempotencyKey` 上限 200（`:585`）；`WF_STATE_APPROVAL_STALE`（`:154`） | `runtime-semantics.md:361-381`（5 个审批态 + T1–T9 转换表）、`:430-452`（等待五条硬规则） | `apps/api/src/workflow-approval.test.ts`：唯一允许省略 `selectedCandidateKey` 的门；等待期间 `noNewVendorCallsWhileWaiting` |
| **S5 渲染规格编译**（`s5_render_specs`，transform，`vendorCall:false` `:349`，`retryPolicy.mode:none` `:378`，`canvasProjection.creates:none` `:379`） | `panelRenderSpecSetSchema`（`:640-645`）；`WF_LIMIT_PROMPT_CHARS` 产出点 `:959`（`spec.promptText.length > 20_000`）；`WF_LIMIT_REFERENCES` `:945`；`WF_REF_ASSET_NOT_APPROVED` `:929`/`:950` | `packages/domain/src/index.ts:330`（提示词正文 20000 上限）；`workflow-definition.v1.json:372`（`promptCharLimit:20000`）、`:370-377`（编译规则：按场景/角色/单格裁剪，只引用已批准资产） | `workflow-definition-contract.test.ts`：s5 的 `runIds` 恒为空（`runtime-semantics.md:84-104`）；提示词 20841 字符 → 仅 `WF_LIMIT_PROMPT_CHARS` |
| **g_assets 资产门（唯一可信的角色一致性来源）**（gate，`targetKind:asset_candidate`，`perItemApproval:true`，`selectedCandidateKeyRequired:true` `:308-339`） | `approvedAssetRefSchema`（`:510-527`）；审批必须绑定 `assetId + version + contentDigest`；`WF_STATE_APPROVAL_DUPLICATE`（`:156`）、`WF_STATE_APPROVAL_STALE`（`:154`） | `runtime-semantics.md:385-390`（四种重复提交必须区分）、`:395-419`（三个不同的事实）；反例 `apps/api/src/connected-image-results.ts:55`（取「最近成功」而非「已批准」） | `apps/api/src/workflow-approval.test.ts`：逐 itemKey 审批；`preserveOtherItemApprovals`；重复提交同 `approvalId` + 同内容无副作用 |
| **S6 分格出图（foreach 付费扇出，核心失败矩阵）**（`s6_panel_render`，`budgetClass:image`，`hardCap:2000`，`failFast:false` `:402`，`independentCheckpointPerItem:true` `:403`，单格失败不得触发整篇重画 `:405`） | `panelCandidateSetSchema`（`:647-672`）；`WF_STATE_SEND_UNKNOWN`（`:157`）；`WF_REPLAY_GENERATION_REVISION_REQUIRED`（`:162`） | `packages/execution/src/index.ts:737`（`record.status !== 'pending'` 即拒绝再次创建）；`workflow-definition.v1.json:421-427`（`needs_review` + 禁自动重发 + 禁换幂等键）、`:429-435`（复用 `apps/worker/src/generation-concurrency.ts:21`） | `apps/worker/src/workflow-recovery.test.ts`：4 格中第 3 格失败 → 只新建第 3 格的 Run（`stepRun 4 / Run 5 / POST 5`），其余 3 格不重发 |
| **S7 质检与返修**（`s7_quality`，generate，`budgetClass:vision`，`visionOptional:true` `:451`，`reworkPolicy` `:474-483`） | `qualityReportSchema`（`:674-706`）；`WF_REPLAY_GENERATION_REVISION_REQUIRED`（`:162`）；`WF_BUDGET_EXCEEDED`（`:166`） | `workflow-definition.v1.json:469-473`（三个独立事实）、`:484-488`（无 vision 绑定则跳过且 `visionScore=null`） | `apps/worker/src/workflow-recovery.test.ts`：未绑定 vision → 0 次视觉调用、0 个 Run；「再画一张」必须提升 `generationRevision` |
| **S8 排版与整页合成**（`s8_layout` `:494` transform、`vendorCall:false` `:499`、确定性 `:533-538`；`s8_render_pages` `:544` generate、`budgetClass:image`、taskTemplate `comic-page-compose.v1`） | `pageLayoutSchema`（`:723-771`）；`renderedPageSetSchema`（`:773-795`）；`rectSchema`（`:714`）；`WF_LAYOUT_*` 产出点 `:919`/`:922`/`:972`/`:975`/`:976`/`:982`/`:985` | `apps/worker/src/workflow-dag.ts:30`（`workflowExecutionOrder`）、`apps/worker/src/index.ts:1043`、`:1554`（既有派发与拓扑） | `apps/worker/src/workflow-recovery.test.ts`：同输入两次排版字节相同（布局是内容输入，参与指纹）；`s8_layout` 不产生 Run |
| **g_final 终审门**（gate，`targetKind:page_render`，`perPageApproval:true` `:593-616`） | `approvalDecisionSchema`（`:561-612`）；`comicExportManifestSchema.excludedPanels`（`:831`）；`WF_STATE_APPROVAL_STALE`（`:154`） | `runtime-semantics.md:456-460`（三个门的差异：`invalidate_this_gate_and_export_only` + `preservePanelApprovals`） | `apps/api/src/workflow-approval.test.ts`：逐页审批；失效只波及本门与导出，已批准分格保持有效 |
| **S9 导出（终态）**（`s9_export`，transform，`vendorCall:false`，`dependsOn:g_final`，`exportPolicy` `:628-636`） | `comicExportManifestSchema`（`:797-841`）；`WF_EXPORT_INCOMPLETE` 产出点 `:961`/`:991`/`:992`；`WF_EXPORT_VERSION_MISMATCH` 产出点 `:993` | `apps/api/src/export.ts:7`（`EXPORT_SCHEMA_VERSION = 1`，与 manifest 的 `schemaVersion` 同名不同义，刻意不复用）；`workflow-definition.v1.json:759-764`（`notSufficientForDelivery`：工作流 JSON / 结果文件列表 / manifest.json / 资产 ZIP 四项各自单独出现都不构成交付） | `apps/worker/src/workflow-recovery.test.ts`：只导出已批准版本；`excludedPanels` 必须显式列出；`definitionVersion !== '0.1.0'` → `WF_EXPORT_VERSION_MISMATCH` |
| **横切：标识、幂等与恢复** | `submitIdempotencyKey()`（`:1072-1090`，折叠阈值 80 字符、上限 200）；`WF_REPLAY_*`（`:161-163`） | `prisma/schema.prisma:382`（`@@unique([projectId, idempotencyKey])`）、`:370`（`Run.retryOf`）；`packages/domain/src/index.ts:1651`（key 上限 200）；`packages/execution/src/index.ts:68`（外部 Run ID ≠ 数据库 UUID）、`:184`、`:297`、`:737` | `apps/worker/src/workflow-recovery.test.ts`（12 个 case 全量）、`workflow-restart-recovery.integration.test.ts`（case 11） |
| **横切：画布投影与并发写** | `canvasProjectionPolicy`（`workflow-definition.v1.json:718-746`）：`stable_node_per_item` `:719`、`mustNotCreateNodePerAttempt` `:722`、`batch_canvas_command_with_expectedRevision` `:725`、`mustNotResendWholeStaleDocument` `:726` | `apps/api/src/projects.ts:794`（当前是 `canvasEdge.deleteMany` + `canvasNode.deleteMany` 的整篇覆盖写）；`apps/web/src/App.tsx:849`（`canvasRevisionRef`）、`:1877`（`saveCanvas`）、`:1888`（整篇快照 + revision）、`:1895`（409 分支重发整篇快照） | `apps/web/e2e/workflow-canvas-concurrency.spec.ts`：后台建图与前端自动保存并发时节点数只增不减，409 不得以整篇旧快照覆盖 |

---

## 2. 错误码覆盖表：`WORKFLOW_ISSUE_CODES` 全 35 个

「产出者」= 该码在 `contracts.ts` 中真正被 `add()` 抛出的位置（现测行号）；「无产出者」= 该码只在 `WORKFLOW_ISSUE_CODES`（`:121-172`）里声明、在 `contracts.ts` 内没有任何抛出点，只能由运行时（workflow 层）产生。
「覆盖来源」：`theme-mini@NNN` = `fixtures/theme-mini/expected-artifacts.json:NNN` 的负样例；`huozhai@NNN` = `fixtures/huozhai-s01/expected-artifacts.json:NNN`；`rc_*` = `fixtures/recovery-cases.json` 的恢复场景。

| 错误码 | contracts.ts 产出者 | 覆盖来源 | 判定 |
|---|---|---|---|
| `WF_SCHEMA_VERSION_UNSUPPORTED` | 无产出者 | —— | **未覆盖** |
| `WF_INPUT_INVALID` | 无产出者（`workflow-definition.v1.json:61` 预检声明） | —— | **未覆盖** |
| `WF_STABLE_ID_INVALID` | 无产出者（`stableIdSchema:85` 只传 message，不带 `workflowIssueCode`） | —— | **未覆盖** |
| `WF_DUPLICATE_STABLE_ID` | `:883` | theme-mini@727 | 覆盖 |
| `WF_TASK_TEMPLATE_MISSING` | 无产出者 | —— | **未覆盖** |
| `WF_MODEL_BINDING_MISSING` | 无产出者 | —— | **未覆盖** |
| `WF_REF_DANGLING` | `:904`、`:905`、`:906`、`:943`、`:967`、`:975`、`:976` | —— | **未覆盖**（有产出者，无负样例） |
| `WF_REF_UNKNOWN_SPEAKER` | `:896` | theme-mini@697；huozhai@724 | 覆盖 |
| `WF_REF_ITEM_KEY_INVALID` | `:931` | theme-mini@707 | 覆盖 |
| `WF_REF_ASSET_VARIANT_MISSING` | 无产出者 | —— | **未覆盖** |
| `WF_REF_ASSET_NOT_APPROVED` | `:929`、`:950` | theme-mini@702；huozhai@730 | 覆盖（huozhai@731-732 实测同时返回 `["WF_LIMIT_REFERENCES","WF_REF_ASSET_NOT_APPROVED"]`，**断言必须用「包含」而非「等于」**） |
| `WF_REF_ASSET_VERSION_STALE` | `:934`、`:955` | theme-mini@712；huozhai@737、@743 | 覆盖 |
| `WF_LIMIT_CHARACTERS` | `:874` | —— | **未覆盖**（theme-mini@726 刻意让角色 id 集合仍为 2 以避免连带触发） |
| `WF_LIMIT_SCENES` | `:877` | theme-mini@732 | 覆盖 |
| `WF_LIMIT_PAGES` | `:911` | —— | **未覆盖** |
| `WF_LIMIT_PANELS` | `:913` | —— | **未覆盖** |
| `WF_LIMIT_REFERENCES` | `:945` | theme-mini@717；huozhai@749（另见 huozhai@730 的连带返回） | 覆盖 |
| `WF_LIMIT_PROMPT_CHARS` | `:959` | theme-mini@722；`rc_prompt_too_long` | 覆盖 |
| `WF_LIMIT_FOREACH_ITEMS` | 无产出者（`workflow-definition.v1.json` 只有 `hardCap`） | —— | **未覆盖** |
| `WF_LAYOUT_RECT_INVALID` | `:972` | theme-mini@747；huozhai@755 | 覆盖 |
| `WF_LAYOUT_PANEL_MISSING` | `:985` | theme-mini@737 | 覆盖 |
| `WF_LAYOUT_BALLOON_OVERFLOW` | `:982` | theme-mini@742 | 覆盖 |
| `WF_LAYOUT_READING_ORDER_INVALID` | `:919`、`:922` | —— | **未覆盖**（`pageLayoutSchema.balloons[].readingIndex`（`:763`）至今没有任何校验） |
| `WF_STATE_APPROVAL_STALE` | 无产出者（仅在注释 `:568` 出现） | `rc_stale_approval` | 覆盖（由运行时产生；`runtime-semantics.md:379` T7、`:387-388`） |
| `WF_STATE_APPROVAL_TARGET_MISMATCH` | `:592`、`:606`（`approvalDecisionSchema.superRefine`） | —— | **未覆盖**（⚠️ `README.md:166` 的 P3 完成标志**明确要求证明它**，但没有任何夹具覆盖） |
| `WF_STATE_APPROVAL_DUPLICATE` | 无产出者 | `rc_duplicate_approval` | 覆盖 |
| `WF_STATE_SEND_UNKNOWN` | 无产出者 | `rc_send_unknown` | 覆盖 |
| `WF_STATE_STEP_REVISION_MISMATCH` | 无产出者 | —— | **未覆盖** |
| `WF_REPLAY_FINGERPRINT_MISMATCH` | 无产出者 | —— | **未覆盖** |
| `WF_REPLAY_GENERATION_REVISION_REQUIRED` | 无产出者 | `rc_upstream_revision_change` | 覆盖 |
| `WF_REPLAY_KEY_TOO_LONG` | 仅 `throw new Error('WF_REPLAY_KEY_TOO_LONG')`（`:1087`，裸 Error，**不是** `workflowIssue()`） | —— | **未覆盖**（`workflowIssueCodesOf()`（`:200`）无法提取，与设计决策 D1 冲突） |
| `WF_BUDGET_EXCEEDED` | 无产出者（`workflow-definition.v1.json:706-710` `exhaustionBehavior`） | `rc_budget_exhausted` | 覆盖 |
| `WF_BUDGET_UNKNOWN_PRICE` | 无产出者（`budgetPolicy.unknownPrice` `:700-705`） | —— | **未覆盖** |
| `WF_EXPORT_INCOMPLETE` | `:961`、`:991`、`:992` | theme-mini@752；huozhai@761；`rc_single_item_failure` | 覆盖 |
| `WF_EXPORT_VERSION_MISMATCH` | `:993` | huozhai@767 | 覆盖 |

**覆盖算术**：35 个码中 **18 个已被覆盖**（13 个由两个 `expected-artifacts.json` 负样例覆盖：`WF_DUPLICATE_STABLE_ID`、`WF_REF_UNKNOWN_SPEAKER`、`WF_REF_ITEM_KEY_INVALID`、`WF_REF_ASSET_NOT_APPROVED`、`WF_REF_ASSET_VERSION_STALE`、`WF_LIMIT_SCENES`、`WF_LIMIT_REFERENCES`、`WF_LIMIT_PROMPT_CHARS`、`WF_LAYOUT_RECT_INVALID`、`WF_LAYOUT_PANEL_MISSING`、`WF_LAYOUT_BALLOON_OVERFLOW`、`WF_EXPORT_INCOMPLETE`、`WF_EXPORT_VERSION_MISMATCH`；另 5 个由恢复场景覆盖：`WF_STATE_SEND_UNKNOWN`、`WF_STATE_APPROVAL_STALE`、`WF_STATE_APPROVAL_DUPLICATE`、`WF_REPLAY_GENERATION_REVISION_REQUIRED`、`WF_BUDGET_EXCEEDED`），**17 个未覆盖**。
**结构性缺口**：35 个码中有 **16 个在 `contracts.ts` 内根本没有产出者**（`WF_SCHEMA_VERSION_UNSUPPORTED`、`WF_INPUT_INVALID`、`WF_STABLE_ID_INVALID`、`WF_TASK_TEMPLATE_MISSING`、`WF_MODEL_BINDING_MISSING`、`WF_REF_ASSET_VARIANT_MISSING`、`WF_LIMIT_FOREACH_ITEMS`、`WF_STATE_APPROVAL_STALE`、`WF_STATE_APPROVAL_DUPLICATE`、`WF_STATE_SEND_UNKNOWN`、`WF_STATE_STEP_REVISION_MISMATCH`、`WF_REPLAY_FINGERPRINT_MISMATCH`、`WF_REPLAY_GENERATION_REVISION_REQUIRED`、`WF_BUDGET_EXCEEDED`、`WF_BUDGET_UNKNOWN_PRICE`、`WF_REPLAY_KEY_TOO_LONG`）。其中 15 个属于「运行时才知道」的状态码，合理；但 `WF_REPLAY_KEY_TOO_LONG` 属于契约自身的长度校验，缺少产出者是缺陷。

---

## 3. 场景预期数字表（`fixtures/recovery-cases.json` 的 12 个 case）

数字均为**绝对计数**（不是增量），语义见夹具 `_fixture.fieldSemantics`：`stepRunCount` = 该 Run 下 `WorkflowStepRun` 行数（按四元组唯一，技术重试不新增行）；`runCount` = 既有 `Run` 行数；`vendorCreateRequests` = 到达供应商 POST 的请求数；`approvalStatus` 是**被断言的那个 itemKey** 的状态，不是整个门的状态（门可以同时持有多个逐项状态）。

| caseId | 严重度 | stepRun 数 | Run 数 | 供应商创建请求数 | WorkflowRun.status | 审批态（被断言 itemKey） | 画布节点变化 | 导出文件 |
|---|---|---|---|---|---|---|---|---|
| `rc_duplicate_submit` | blocker | 1 | 1 | 1 | `running` | `pending` | +1（`character:linwan@base`，total 1） | 无 |
| `rc_send_unknown` | blocker | 1 | 1 | 1 | `needs_review` | `approved`（`panel:p1_3`） | +1（`panel:p1_3`，total 1） | 无 |
| `rc_archive_failure` | high | 1 | 1 | 1 | `awaiting_decision` | `awaiting_decision` | +1（`character:linwan@base`，total 1） | 无 |
| `rc_stale_approval` | high | 1 | 0 | 0 | `awaiting_decision` | `stale` | 0（total 0） | 无 |
| `rc_duplicate_approval` | high | 1 | 0 | 0 | `awaiting_decision` | `approved`（`character:linwan@base`） | 0（total 0） | 无 |
| `rc_single_item_failure` | high | 4 | 5 | 5 | `failed` | `pending` | +4（`panel:p1_1`…`p1_4`，total 4） | 无（导出被 `WF_EXPORT_INCOMPLETE` 阻断） |
| `rc_upstream_revision_change` | high | 4 | 4 | 4 | `running` | `stale`（`character:linwan@base`；`character:qiao@base`、`scene:temple@night` 保持 `approved`） | 0（total 4；重画复用同一稳定节点） | 无 |
| `rc_budget_exhausted` | medium | 11 | 10 | 10 | `failed` | `approved` | +11（节点列表见夹具 `expectedState.canvasNodes.nodeKeys`） | 无 |
| `rc_cancel_late_result` | medium | 4 | 4 | 4 | `cancelled` | `pending` | +4（`panel:p1_1`…`p1_4`，total 4；迟到结果进 `auditRunIds`，不被采纳） | 无 |
| `rc_concurrent_canvas_write` | blocker | 1 | 0 | 0 | `running` | `pending` | +4（`step:s2_script`、`N6`、`N7`、`N8`；total 9，节点只增不减） | 无 |
| `rc_restart_recovery` | high | 12 | 11 | 11 | `running` | `approved`（4 条审批） | 0（total 12；恢复过程不得新建任何画布节点） | 无 |
| `rc_prompt_too_long` | medium | 1 | 0 | 0 | `failed` | `approved` | 0（`s5_render_specs.canvasProjection.creates = none` `:379`） | 无 |

配套读法：每个 case 还有 `preconditions`（含已持久化的 digest/幂等键占位符）、`events`（`at`/`action`/`detail`/`expectedReaction`）、`mustNot`（禁止行为清单）与 `relevantCodeRefs`。事件序列里带 `$digest:*`、`$key:*` 的字符串由 `_fixture.digests` / `_fixture.idempotencyKeys` 解析；P2 必须用真实哈希重算，不能照抄占位符。

---

## 4. 四阶段验收入口

`README.md:149` 要求：每阶段的完成标志必须是**一条可执行、可复现、会失败的命令或断言**，不是「评审通过」。

### P1 契约与样例定标（`README.md:153`）
- **完成标志 1**：一条命令对 `fixtures/**/expected-artifacts.json` 的每个正向样例运行 `validateComicArtifacts()`，返回的 `issueCodes` 数组**为空**。
- **完成标志 2**：`fixtures/recovery-cases.json` 与两个 `expected-artifacts.json` 的每个负样例，运行后返回的错误码集合**恰好等于**指定码（`huozhai` 的 `WF_REF_ASSET_NOT_APPROVED` 一条为例外，其自述要求用「包含」断言，见 `:731-732`）。
- **完成标志 3**：`STEP_OUTPUT_SCHEMAS`（`contracts.ts:1111`）的 12 个键与 `workflow-definition.v1.json` 中所有 `outputSchema` 取值**双向**完全一致（不多不少）。
- **当前状态**：完成标志 2、3 的**数据已具备**；标志 1 尚未实跑（P1 收口命令待执行）。

### P2 Mock 持久化纵切（`README.md:160`）
在 Mock provider 下把 `fixtures/theme-mini/input.json` 跑成一整条 `WorkflowRun`：每页 1 个 `WorkflowStepRun`、每格 4 个、资产 2 个角色 + 1 个场景，**零真实付费请求**，三个 gate 全部停在 `awaiting_decision`，且进程重启后能接着跑完。必须包含以下 7 条断言（对应 §3 的 case）：
1. 重复提交只受理一次（`rc_duplicate_submit`：`stepRun 1 / Run 1 / POST 1`）。
2. 重启恢复原 Run（`rc_restart_recovery`：复用既有 `WorkflowRun`，不新建）。
3. 已成功子项不重发（同一 case：恢复期间 `vendorCreateRequests` 增量为 0）。
4. 重复审批无副作用（`rc_duplicate_approval`：同 `approvalId` + 同内容 → `approvalRows` 仍为 1）。
5. 过期审批被拒绝（`rc_stale_approval` → `WF_STATE_APPROVAL_STALE`，`approvalRows 0`）。
6. 等待审批期间零新增生成（三个 gate 的 `noNewVendorCallsWhileWaiting`）。
7. UI 与后台同时写画布不丢节点（`rc_concurrent_canvas_write`：total 9，且 409 不得以整篇旧快照覆盖）。

### P3 小规模真实闭环（`README.md:166`）
真实 provider，按 `README.md` §2 的规模（1 页 / 4 格 / 2 角色 / 1 场景）跑一轮，产出 `comic_export_manifest`：`pages.length === 1`、`excludedPanels` 为空、`definitionVersion === '0.1.0'`；并**可复现地**证明三个门的负例：过期审批被拒（`WF_STATE_APPROVAL_STALE`）、目标不匹配被拒（`WF_STATE_APPROVAL_TARGET_MISMATCH`）、重复审批无副作用。⚠️ 第二个负例目前**没有夹具**（见 §2），P3 开始前必须先补。

### P4 产品化与扩展（`README.md:173`）
在不改变 `contracts.ts` 任何既有字段语义的前提下：把 1 页扩到 N>1 页（仍用同一份 definition），并新增一个非仙侠题材（不改契约）；`CONTRACT_SCHEMA_VERSION` 保持 1。

---

## 5. P1 自检清单

- [x] **正向样例全部通过 schema（数据侧）**：`fixtures/theme-mini` 与 `fixtures/huozhai-s01` 的正向样例字段逐一对照 `contracts.ts` 的 12 个产出 schema 与 `STEP_OUTPUT_SCHEMAS`（`contracts.ts:1111`）交叉核对，无缺字段、无多余字段；`_fixture` 声明的规模与 `README.md:23` §2（1 页 / 4 格 / 2 角色 / 1 场景）一致。**尚未实跑 `validateComicArtifacts()`，见 §4 P1 完成标志 1。**
- [x] **角色、格子、对白、资产引用无悬空（正向样例侧）**：正向样例中每个 `dialogue.speakerCharacterId`（`contracts.ts:896`）、`panel.beatId` / `panel.sceneId` / `panel.characterIds` / `panel.dialogueIds`（`:904-906`）、`renderSpec.panelId`（`:943`）、`referenceAssetRefs.itemKey`（`:929-934`）、`balloon.panelId` / `balloon.dialogueId`（`:975-976`）都能在对应上游产物中解析；悬空情形被**刻意隔离**到负样例，且负样例都注明了「为何不会连带触发其他码」（如 theme-mini@726、@731）。
- [x] **负向样例对应明确错误码**：`fixtures/theme-mini` 12 条、`fixtures/huozhai-s01` 8 条均带 `expectedIssueCode`；`fixtures/recovery-cases.json` 12 个 case 的 `expectedState.issueCodes` 与 `expectedState.issueCodesByEvent` 给出逐事件期望码。**尚未覆盖的 17 个码已在 §2 显式标注 `未覆盖`**——这是本阶段最重要的发现。
- [x] **每一步能说清输入什么、产生什么、谁批准、怎样恢复**：输入/产出见 `contracts.ts` 的 `STEP_OUTPUT_SCHEMAS` + `workflow-definition.v1.json` 各 step 的 `inputBindings`/`outputSchema`；审批见三个 gate（`g_story`/`g_assets`/`g_final`，`workflow-definition.v1.json:199`/`308`/`593`）与 `runtime-semantics.md:357-421`；恢复见 `retryPolicy.classification`（`:647-683`）与 `runtime-semantics.md:517-597`、`fixtures/recovery-cases.json` 的 12 个 case。

---

## 6. 本阶段发现（不一致与缺口）

> `README.md:218` §9 已登记的 8 条不一致（`isPortConnectionAllowed` 行号、`promptDocumentSchema` 行号、`taskTemplates.requiredForStepTypes` 遗漏三个 fanout 步、`submitIdempotencyKey` 折叠与裸 Error、`qualityReportSchema` 无法表达返修目标、`targetKind:panel_candidate` 无门、`validateComicArtifacts` 输入面过窄、`definitionDigestInputs` 漏 `form`/`formNonGoals`）在此**只记为「已登记 §9 #N」，不重复计入新发现**。

**新发现（本文档编写期间实测）**

1. **17 个错误码在现有夹具中完全没有覆盖**（§2 已逐条标注），其中 `WF_STATE_APPROVAL_TARGET_MISMATCH` 是硬伤：`README.md:166` 的 P3 完成标志明确要求证明它，它却既无夹具也无恢复场景，虽然 `contracts.ts:592`/`:606` 有产出者。建议 P1 收口前补一条负样例（同一 `approvalId` 换 `targetArtifactDigest` 或改 `selectedCandidateKey`）。
2. **`WF_REPLAY_KEY_TOO_LONG` 无法被 `workflowIssueCodesOf()` 提取**：`contracts.ts:1087` 抛的是裸 `Error`，不带 `params.workflowIssueCode`，与设计决策 D1（`contracts.ts:42-69`「机器码统一走 params.workflowIssueCode」）冲突；同时它是「契约自身的长度校验却无产出者」的孤例。
3. ~~**`runtime-semantics.md` 内部存在一处新的枚举缺口**~~ —— **已裁决并修复（P1 收口，2026-10-16）**：`runtime-semantics.md:46` 的 `WorkflowRun.status` 已扩充为 `running / awaiting_decision / succeeded / failed / needs_review / cancelled`，并注明 `needs_review` 是可再入状态、不属于 `RunStatus`。原先「`needs_review` 在 `:46` 中没有位置，而 `:544-545` 要求把已 succeeded 的 `WorkflowRun` 置为 `needs_review`」的内部矛盾已消除，`fixtures/recovery-cases.json` 的 `rc_send_unknown` 所依赖的运行级 `needs_review` 现有权威出处。采用「扩充枚举」而非「限制在 `WorkflowStepRun.status` 上」，理由是 §9.3 明言运行级也要落这个状态，若只用 `issueCode` 表达则 `rc_send_unknown` 的 `WorkflowRun.status` 无值可写。详见 `FINDINGS-p1.md` F-22。
4. **归档失败没有任何错误码**：`workflow-definition.v1.json:654-658` 的分类项（已有结果但归档失败 → `recover_existing_result`）**没有 `issueCodes` 字段**，`WORKFLOW_ISSUE_CODES` 里也没有对应码。因此 `rc_archive_failure` 的期望码数组只能是 `[]` —— 正确但不可断言，恢复路径无法用错误码锁定。
5. **`README.md:129` §6 第 12 行与本任务的数据模型定义不同**：README 把 `fixtures/recovery-cases.json` 描述为「负样例集：每条给出输入 + 指定错误码，用于证明错误码可被 `workflowIssueCodesOf()` 提取」（P1 语义），而本次交付把它实现为「事件序列 → 期望状态」的 P2 恢复场景库（并另带 `expectedState.issueCodes`）。两种读法可共存，但 **README §7 的 P1 完成标志第二条依赖负样例形式**；`fixtures/recovery-cases.json` 因此同时携带 `coverage.coveredByArtifactFixtures` / `uncoveredByAllFixtures` 两个块以兼容两种读法。建议 README 第 12 行改写为两用途说明。
6. **并行编辑导致行号漂移，交叉引用不可靠**：本次编写期间 `contracts.ts` 的 `validateComicArtifacts()`（`:853→:855`）及其后所有产出点整体后移 2 行，`fixtures/huozhai-s01/expected-artifacts.json` 整体后移 34 行。三个文件互相按行号引用（`contracts.ts:24-27` 引用 `packages/domain`，`workflow-definition.v1.json:372` 引用 `packages/domain/src/index.ts:330`，夹具引用 `contracts.ts`），**行号不是稳定锚点，符号名与错误码才是**。已按现测值校正 `fixtures/recovery-cases.json` 内的 `contracts.ts:1070→:1072`、`:931-933→:933-935`、`:957→:959`、`:241-252→:244-253`、`:226-238→:231-243`。
7. **`WF_REF_ASSET_NOT_APPROVED` 的负样例无法用「等于」断言**：`fixtures/huozhai-s01/expected-artifacts.json:730-732` 自述实际返回 `["WF_LIMIT_REFERENCES","WF_REF_ASSET_NOT_APPROVED"]`。P2 必须对这些样例统一采用「包含指定码」的断言口径，否则测试会假失败——这一点必须写进 P2 的测试约定。
8. **`WF_LAYOUT_READING_ORDER_INVALID` 有产出者却无覆盖**，且它只校验 `panelPlan` 的 ordinal（`:919`、`:922`），`pageLayoutSchema.balloons[].readingIndex`（`:763`）从定义至今没有任何校验点——「阅读顺序」这条需求目前只被证明了一半。
