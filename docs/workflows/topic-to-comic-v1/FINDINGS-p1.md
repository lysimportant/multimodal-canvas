# P1 发现清单（契约缺口与待决问题）

本文件记录在编写 P1 交付物过程中**被真实发现的**契约缺口、语义空档与不一致。
这些不是"以后再说"的备注，而是**必须在 P2 写测试前定下来的决定**。

约定：
- `[缺口]` 表示契约无法表达某个已被证明需要的语义 → 需要改 `contracts.ts` 或 `workflow-definition.v1.json`
- `[空档]` 表示契约允许某状态但没人校验 → 需要补校验或明确宣布不管
- `[待决]` 表示需要产品/技术决策，不是补字段就能解决
- 每条都有 `处置` 字段：`已修` / `待修` / `显式不管`

状态：P1 编写期，尚未评审。

---

## F-01 资产候选缺少 `runId`，成本无法归集

- 类型：`[缺口]`
- 位置：`contracts.ts` 的 `assetCandidateSetSchema`；对照 `contracts.ts:661` 的 `panelCandidateSetSchema.candidates[].runId`
- 问题：格图候选（S6）带 `runId`，**资产候选（S4）不带**。于是"每一项资产候选花了哪次 Run 的钱"追不回来。
- 影响：`model-budget-matrix.md` 第 8 节要求的"每个候选都能追到具体 Run id"对 S4 不成立。S4 恰恰是**最贵的步骤**（2 角色 + 1 场景 × 最多 2 候选）。
- 处置：`待修` —— 给 `assetCandidateSetSchema.candidates[]` 补 `runId` 字段，与 S6 对齐。

## F-02 并发层级无法在契约中表达

- 类型：`[缺口]`
- 位置：`workflow-definition.v1.json` 只有步骤级 `maxConcurrency`；`apps/worker/src/generation-concurrency.ts:21` 是**单一全局上限**
- 问题：缺少"工作流级并发上限"与"凭据/模型级吞吐上限"两个层级。步骤级 4 个 fan-out 同时跑，会一起顶到全局上限，互相抢额度。
- 影响：预算预留与公平调度都建立在不存在的层级上。
- 处置：`待修` —— 要么在 `workflowDefinitionSchema` 加 `concurrency` 对象（`{ workflow, perCredential, perModel }`），要么在文档里**显式宣布**首版只有两级（步骤级 + 全局）并说明理由。

## F-03 `s8_layout` 是纯转换却带 `maxConcurrency`

- 类型：`[空档]`
- 位置：`workflow-definition.v1.json:508`，`maxConcurrency: 2`
- 问题：`s8_layout` 是 `type: "transform"`，**不产生任何供应商请求**，却带了并发上限。字段语义与 `s6_panel_render` 这类真 fan-out 不同，容易被误读成"会花钱"。
- 处置：`待修` —— 移除该字段，或在 schema 里把 `maxConcurrency` 限定为 `generate` + `fanout` 才允许出现（推荐后者，让非法配置无法通过校验）。

## F-04 `budget.counters` 7 项 vs `budgetPolicySchema` 8 字段

- 类型：`[缺口]`
- 位置：`workflow-definition.v1.json` 的 `budget.counters`（7 项）vs `contracts.ts` 的 `budgetPolicySchema`（8 字段）
- 问题：差额是 `amountBudget` —— 它是**金额预算**，不是计数器，因此在 `counters` 里无处声明。两边数量对不上会被实现者当成笔误。
- 处置：`待修` —— 把 `amountBudget` 从 `counters` 概念里明确剥离，在 `budget` 下与之平级声明，并在两边注释里写明"7 个计数器 + 1 个金额上限"。

## F-05 参考图能力是空壳，无人校验模型是否真接受多张参考图

- 类型：`[空档]`
- 位置：`apps/api/src/resource-mention-capabilities.ts:74` —— `checkResourceMentionCapabilities()` 当前直接返回 `issues: []`
- 问题：整条角色一致性方案**建立在"模型能接受多张参考图并保持身份"这个未验证前提上**。目前没有任何代码校验它，`issues: []` 会被误读为"已验证支持"。
- 影响：这是**最高风险项**。如果前提不成立，S4/S6 的设计要重做。
- 处置：`待决` —— 必须先用"真实适配路径小样"验证（`model-budget-matrix.md` 已给 6 步清单与 4 级降级），**验证通过前不得把 `issues: []` 当作支持性证据**。

## F-06 `maxVisionReviews` 的计数粒度未定义

- 类型：`[空档]`
- 位置：`workflow-definition.v1.json` 的 `s7_quality`（普通 `generate`，非 fanout）；`contracts.ts` 的 `qualityReportSchema.panels[]` 与 `panelCandidateSet` 一一对应
- 问题：一次 `s7_quality` Run 内部可能对 4 个格**各做一次视觉调用** —— 那算 1 次还是 4 次 `maxVisionReviews`？契约没写。
- 影响：预算上限可被绕过（一次 Run 内无限次视觉调用）。
- 处置：`待修` —— 明确按**供应商视觉调用次数**计数（即 4 次），并要求 Run 回报实际调用次数供结算核对。

## F-07 `maxRegenerationsPerItem` 缺"触发主体"字段

- 类型：`[缺口]`
- 位置：`contracts.ts` 有 `WF_REPLAY_GENERATION_REVISION_REQUIRED` 与 `generationRevision`，但没有字段说明**谁有权发起重生成**
- 问题：契约能表达"重生成必须提升 revision"，但无法表达"这一步允不允许用户重生成"。
- 影响：`maxRegenerationsPerItem` 的约束对象不明确 —— 是所有步骤？还是只有带人工 gate 的步骤？
- 处置：`待修` —— 在步骤定义里加 `regenerationPolicy`（`allowed` / `gateOnly` / `forbidden`），并让 `maxRegenerationsPerItem` 只对 `allowed` 的步骤生效。

## F-08 `WF_BUDGET_UNKNOWN_PRICE` 与合法配置 `amountBudget: null` 的边界未写明

- 类型：`[空档]`
- 位置：`contracts.ts` —— `amountBudget: null` 是**合法配置**（表示未知价格），同时存在错误码 `WF_BUDGET_UNKNOWN_PRICE`
- 问题：同一种状态（价格未知）既合法又会报错，实现者无法判断何时该报。
- 处置：`待修` —— 写明规则：`amountBudget: null` 合法且**不报错**，但必须标记成本为"未知"、由请求数硬上限兜底、**绝不能显示为零成本**；`WF_BUDGET_UNKNOWN_PRICE` 只在"用户显式要求金额校验但价格未知"时触发。

## F-09 已修：`contracts.ts` 真实语法错误（阻断级）

- 类型：`[缺口]`
- 位置：原 `contracts.ts:850` 的 JSDoc 里写了 glob `fixtures/*/expected-artifacts.json`
- 问题：其中 `*/` **提前闭合了块注释**，`:850` 尾部与 `:851` 整行被当成代码。tsc 5.9.3 报 6 条 `parseDiagnostics`（invalid character / ';' expected / unterminated regex literal）。`contracts.ts` 当时**无法被 import 或类型检查** —— P1 的"核心可测单元"按现状跑不起来。
- 处置：`已修` —— 改写该注释，并加一行警示"注释里不要出现斜杠加星号的字符组合"。修后实测 `parseDiagnostics = 0`。
- 教训：以后在文件头注释里写 glob/正则示例时，一律不用裸的星号加斜杠。

## F-10 两处代码行号引用错误

- 类型：`[缺口]`
- 位置：`contracts.ts:24` 与 `workflow-definition.v1.json` 的 `canvasProjectionPolicy.portCompatibility.ref`
- 问题：
  - `isPortConnectionAllowed` 标为 `packages/domain/src/index.ts:1127`，但 `:1127` 只是它在 `canvasDocumentSchema` 内的**调用点**，**定义在 `:2009`**。
  - `promptDocumentSchema` 标为 `:305`，实际定义在 `:300`（`:305` 是 `.strip()`）。`:330` 的 20,000 字符上限引用正确。
- 影响：契约里的"现有模块"锚点是给人按图索骥用的，错行号比没有行号更坏。
- 处置：`待修` —— 订正两处行号。

## F-11 `taskTemplates.requiredForStepTypes` 漏了 `fanout`

- 类型：`[缺口]`
- 位置：`workflow-definition.v1.json` 的 `taskTemplates.requiredForStepTypes`（只声明 `["generate"]`）
- 问题：`s4_asset_candidates`、`s6_panel_render`、`s8_render_pages` 三个步骤是 `fanout` 且 `vendorCall: true`，**都带 `taskTemplate`**。严格按该列表计算 `taskTemplateDigest`，这三个模板的正文**不会进入指纹**。
- 影响：改了格子出图提示词的措辞，指纹不变 → 缓存命中旧结果、幂等键不变 → **用户改了提示词却拿回旧图**。
- 处置：`待修` —— 改为 `["generate", "fanout"]`，或改成"凡带 `taskTemplate` 的步骤一律计入"。

## F-12 `submitIdempotencyKey` 三个缺陷（含付费安全）

- 类型：`[缺口]`
- 位置：`contracts.ts:1070-1088`
- 问题：
  - (a) **折叠阈值错**：触发条件是整串超 80 字符，于是长 `stepId` 会让**短** `itemKey` 也被折叠，与注释声明的意图不符。
  - (b) **碰撞会静默吞掉一个不同的付费子项**：折叠用 32 位非加密 `simpleHash`，不同 `itemKey` 可能撞到同一值，再被 `Run @@unique([projectId, idempotencyKey])`（`prisma/schema.prisma:382`）**静默去重** → 一个付费子项永远不会被创建，而且不报错。
  - (c) **抛出裸 `Error('WF_REPLAY_KEY_TOO_LONG')`** 而非 `workflowIssue(...)`，`workflowIssueCodesOf()` 提取不到，与已定决策 D1（错误一律走稳定码）自相矛盾。
- 影响：这是**唯一会直接导致付费内容丢失且无告警**的缺陷，优先级等同 F-05。
- 处置：`待修` —— 折叠只作用于超过预算的 `itemKey` 分量本身；改用足够宽的加密摘要（并在此处明确可接受碰撞概率）；抛 `workflowIssue`。

## F-13 `qualityReportSchema` 无法承载返工：`WF_REPLAY_GENERATION_REVISION_REQUIRED` 没有产生者

- 类型：`[缺口]`
- 位置：`contracts.ts` 的 `qualityReportSchema`；对照 `workflow-definition.v1.json` 的 `s7_quality.reworkPolicy`
- 问题：`reworkPolicy` 要求 `increment_generation_revision_for_itemKey` 并计入 `maxRegenerationsPerItem`，但 `qualityReportSchema` 只有 `structural.*` 和一个可为 `null` 的 `manual.verdict`，**没有任何字段能表达"哪个 `itemKey` 提升修订、这是第几轮"**。
- 影响：质检要求返工时，运行时无处落地这个决定；`WF_REPLAY_GENERATION_REVISION_REQUIRED` 这个错误码**在整条链上没有任何产生者** —— 一个永远不会被触发的防御。
- 处置：`待修` —— 给 `qualityReportSchema` 加 `rework: { itemKey, reason, round }[]`，并让 `s7_quality` 的后继接线到 `generationRevision` 提升。

## F-14 `panel_candidate` 是死枚举值

- 类型：`[缺口]`
- 位置：`contracts.ts:572` 的 `targetKind`
- 问题：含 `panel_candidate`，但实际 3 个 gate 的 `targetKind` 分别是 `story_scope` / `asset_candidate` / `page_render`。`s6_panel_render` 产出 `panel_candidate_set` 却**没有对应 gate**，`s8_layout` 直接依赖 `s7_quality`。
- 影响：枚举里躺着一个永不出现的值，会让人以为格图候选有人工审批，实际没有。
- 处置：`待修` —— 要么补一个格图候选 gate，要么删掉该枚举值并在文档里明确"格图候选不走人工审批"，二选一，不能含糊。

## F-15 `validateComicArtifacts` 作用域不全

- 类型：`[空档]`
- 位置：`contracts.ts:853` 的入参
- 问题：入参只有 `renderSpecs` / `layouts`，**不含** `panelCandidateSet` / `renderedPageSet` / `qualityReport`。因此"格候选被换过版本"这类陈旧检不出来。另外 `pageLayoutSchema.balloons[].readingIndex`（`contracts.ts:763`）**从未被任何校验读取**，而 `WF_LAYOUT_READING_ORDER_INVALID` 只覆盖 `panelPlan.ordinal`。
- 补充（来自夹具写手）：也不校验 `maxProps`、`maxProfileVariantsPerEntity`、`panel.sceneId` 与 `beat.sceneId` 一致性、`exportManifest.pages[].panelCandidates` 覆盖度。
- 处置：`待修` —— 扩充入参与校验项，或明确宣布这些留给 P2 的集成测试，不在本函数职责内。

## F-16 `definitionDigestInputs` 不含 `form` 与 `formNonGoals`

- 类型：`[缺口]`
- 位置：`workflow-definition.v1.json` 的 `definitionDigestInputs`
- 问题：实测清单为 `["schemaVersion","id","version","inputSchema","outputSchema","steps","taskTemplates","retryPolicy","budgetPolicy","canvasProjectionPolicy","exportPolicy"]`。于是把形态从**分页漫画**改成**条漫**、或删掉一条非目标，`definitionDigest` **不变**，已存在的 `WorkflowRun` 不会被判定为定义已变。
- 影响：`form` 恰恰定义"成品长什么样"，它变了而指纹不变，等于把"定义摘要"这个安全机制在最关键的一维上打穿。
- 处置：`待修` —— 把 `form` 与 `formNonGoals` 加入 `definitionDigestInputs`。

## F-17 潜在冲突：`rejectIfBudgetAbsent` 与 `amountBudget: null`

- 类型：`[待决]`
- 位置：`workflow-definition.v1.json` 的 `s0_brief.preflight.rejectIfBudgetAbsent` vs `budgetPolicy.unknownPrice`
- 问题：前者要求"预算缺失即拒绝"，后者规定"未知价格用 `amountBudget = null` 表示"。两个夹具都按后者用了 `null`，但 preflight 可能把 `null` 读成"预算缺失"从而拒绝整个输入。
- 处置：`待决` —— 明确 `null` 是**显式配置的未知**而非缺失；`rejectIfBudgetAbsent` 应只在 `budget` 对象整体不存在时触发。

## F-18 资产包 A 编号重复：61 个条目只对应 53 个唯一编号

- 类型：`[缺口]`
- 位置：`G:\skillplugins\剧本成品范例\火债\火债_资产提示词包_按出镜顺序_v1(1).md`
- 实测（宽松匹配 `####\s*A\d{3}`）：`####` 标题共 **61** 个，其中 `A` 编号 **61** 个匹配、**唯一仅 53** 个。重复者恰为 8 个，各出现 2 次：**A011、A015、A021、A022、A034、A035、A039、A045**。
- 对照：同一文件 L2241 与 L2247 都自称"全部 **61** 项资产提示词"。→ 该文件**内部自洽**（61 个标题），但与"编号唯一"这一隐含前提冲突。
- 影响：本方案的 `itemKey` 与 `contentDigest` 全链路假设"一个资产一个稳定 ID"。若 P2 真去解析这份资产包，**8 个编号会各自把两个不同资产折叠成一个 `itemKey`** → 审批只批了一个、另一个静默丢失（与 F-12 同类的静默丢内容缺陷，只是来源不同）。
- 处置：`待修/待决` —— 解析资产包时必须按"编号 + 标题名"联合去重，或要求在源文件层面修正编号；在文档里写明"资产包的 A 编号不保证唯一"。

## F-19 资产包 A028 自相矛盾：同一句里既称"空场母版"又安排人物站位

- 类型：`[缺口]`
- 位置：资产包 L1027 —— `资产内容：私密小书房，深木书案、账册、毛笔、砚台、单支蜡烛，背景大面积墨黑，两名手下站位在书案后方；民族二维手绘16:9空场母版，烛光只照局部。`
- 问题：**同一个分号前后**，先写"两名手下站位在书案后方"，再把这个资产定义为"空场母版"。空场母版按定义必须无人物。
- 影响：出图提示词里同时含"有人"和"空场"两个互斥要求，生成结果不可预期；且场景资产一旦带人，人物一致性就绑死在场景资产上，破坏"场景/角色分离"的可复用结构。
- 处置：`待决` —— 由 huozhai 夹具方（已按"无人物"处理并记录）与 P2 的资产提取规则统一口径，并在文档明确"引用该资产时必须忽略人物描述"。

## F-20 `WF_LIMIT_PROMPT_CHARS` 阈值两处来源

- 类型：`[缺口]`
- 位置：`contracts.ts:959` 的 `20_000` 字面量；`workflow-definition.v1.json` 在 `s5_render_specs` 上的 `promptCharLimit: 20000`
- 问题：同一个阈值有两处独立来源。改一处而忘另一处，会出现"校验放行但定义声明拒绝"或反之。
- 处置：`待修` —— 让校验从步骤定义读取该值，或把它提为契约里的单一常量并在两处引用同一来源。

---

## 关于"源文件在任务中被改动"这一说法：**已证伪，不要再追**

huozhai 夹具写手报告其"第一次读到的剧本/分镜与后来不同，文件在任务中途被改过"。**该说法不成立**，已实测证伪：

- 两个文件的 `LastWriteTime` 均为 `2026-10-13 16:53`（剧本 16:53:32 / 20339 bytes，分镜 16:53:30 / 99280 bytes），**早于本次任务开始**；字节数与文件列表记录完全一致。
- 该写手所称"第一次读到"的文本在磁盘上**根本不存在**：`张月坪一家，还剩几口人` 无匹配、`火若留根，张家不能留活口` 无匹配、分镜里 `景别` 出现 **0** 次、`S07-01` 头在 **L266** 而非 L259。磁盘内容与其"重建后"的版本一致。
- 其 33 条 `lineRefs` 我已逐条抽查并通过，与当前磁盘**逐字节一致**：剧本 L218/220/222/225/228/233/238/243/245；分镜 L259/261/262/266/272/278/282；资产包 L5/355/373/978/1011/1015/1027/1056/2247；Seedance L176/188。
- 结论：这是该写手**自己第一次读错后，把自身的阅读不一致叙述成了外部文件变动**（保持字节数不变的整体换文也不可信）。夹具本身是按真实字节重建的，**可继续使用**；但"源文件会漂移"这一前提**不成立**，后续不要再为此重跑 lineRef 校验。

教训：子代理对"外部世界发生了变化"的报告，属于可验证断言，必须回磁盘核对后再采信，也不能因为一处叙述错误就否定它其余的可验证结论 —— 本例中它的 F-18（61/53 重复）、F-19（A028 矛盾）、F-20（阈值两处来源）**全部属实**。

---

## 错误码产出者实测（裁决用，机制核验）

对 `contracts.ts` 做机制核验（提取 `WORKFLOW_ISSUE_CODES` 声明，再在**声明之后的文件正文**中统计各码出现次数）：

- **声明总数 = 35，唯一 = 35。**
- **在 `contracts.ts` 内有产出者/引用 = 21；零引用（无产出者）= 14。**

无产出者的 14 个：

```
WF_SCHEMA_VERSION_UNSUPPORTED      WF_INPUT_INVALID
WF_STABLE_ID_INVALID               WF_TASK_TEMPLATE_MISSING
WF_MODEL_BINDING_MISSING           WF_REF_ASSET_VARIANT_MISSING
WF_LIMIT_FOREACH_ITEMS             WF_STATE_APPROVAL_DUPLICATE
WF_STATE_SEND_UNKNOWN              WF_STATE_STEP_REVISION_MISMATCH
WF_REPLAY_FINGERPRINT_MISMATCH     WF_REPLAY_GENERATION_REVISION_REQUIRED
WF_BUDGET_EXCEEDED                 WF_BUDGET_UNKNOWN_PRICE
```

**订正写手的算术**：`edde0a0b` 报告"16 个连产出者都没有"。实测为 **14 个**。差额正是它自己列出的两项 —— `WF_REF_DANGLING`（正文引用 7 次）与 `WF_REPLAY_KEY_TOO_LONG`（引用 1 次，即 `contracts.ts:1087` 的裸 `throw`）。按"是否被发出"判定，这两个**有产出者**；其中 `WF_REPLAY_KEY_TOO_LONG` 的产出方式是裸 `Error`，因此它另外提出的 D1 冲突（见 F-24）成立，但"无产出者"这一归类不成立。

**这 14 个不是缺陷，而是阶段边界**：`contracts.ts` 只承载**产物校验**（解析 + `validateComicArtifacts`）。`WF_INPUT_INVALID`、`WF_MODEL_BINDING_MISSING`、`WF_BUDGET_*`、`WF_STATE_*`、`WF_REPLAY_*` 的产出者属于**运行时**，而运行时是 P2 才写。因此处置是：**在 `contracts.ts` 内为这 14 个码加显式标注**（"产出者：P2 运行时，见 runtime-semantics.md §X"），否则它们会长期停留在"声明了但没人发"的状态，P2 落地时无人认领。

**未独立复核项**：写手自报"35 个码中 18 个已被夹具覆盖（13 个经负样例 + 5 个经恢复场景）"。我做过一次字符串存在性检查，但 `acceptance-matrix.md` 的错误码覆盖表**本身就逐条列出了全部 35 个码**，故字符串存在性无法证明"被夹具真实触发"，该检查作废、不作为证据。**18/35 这一数字仍属写手自报，未独立复核**；P2 应以"断言真实跑过"为准重新点算。

---

## F-21～F-28 写手 `edde0a0b` 上报、需上层裁决

### F-21 `WF_STATE_APPROVAL_TARGET_MISMATCH` 被写成 P3 完成标志却无任何覆盖（硬伤）
- `[缺口]`。`README.md:166` 的 P3 完成标志**明确要求证明**该码，但无任何夹具/场景覆盖；`contracts.ts:592` / `:606` 有产出者。
- 影响：P3 的完成标志不可验证 —— 这正是本方案最痛恨的"无人推动的步骤"（S8）在**验收标准自身**上的复现。
- 处置：`待决`。要么补一个针对它的负样例，要么把它从 P3 完成标志里删除。**二者必居其一，不能继续挂着。**

### F-22 `WorkflowRun.status` 缺 `needs_review` —— **已裁决并修复**
- `[冲突]` → **已修**。`runtime-semantics.md:46` 的枚举原为 `running / awaiting_decision / succeeded / failed / cancelled`，而 `:544-545` 要求"已 `succeeded` 的 Run 收到迟到结果 → `needs_review`"；`rc_send_unknown` 正需要该值。
- 影响：迟到结果无状态可落 —— 直接关系到 Codex 点名的"最致命两个坑"之一（把 `unknown` 误当可重建失败）。
- **裁决（用户 2026-10-16 拍板）**：扩充枚举。`runtime-semantics.md:46` 现为 `running / awaiting_decision / succeeded / failed / needs_review / cancelled`，并注明 `needs_review` 是**可再入**状态、不属于 `RunStatus`。
- 选择理由（记录，避免日后被当作任意决定）：§9.3 明言**运行级**也要落这个状态；若改为"只限制在 `WorkflowStepRun.status`、由 `issueCode` 表达运行级告警"，则 `rc_send_unknown` 的 `WorkflowRun.status` 无值可写 —— 那等于用错误码掩盖一个真实的状态缺失。
- 联动改动：`fixtures/recovery-cases.json` 的 `_note`（原写"二者不一致、未私自取舍"）已同步更新；`acceptance-matrix.md` 第 3 条发现已标记为已裁决并写明理由。**未改动 `contracts.ts`**（它本就没有 status 枚举，无产出面）。

### F-23 归档失败没有错误码，恢复路径不可断言
- `[缺口]`。`workflow-definition.v1.json:654-658` 的 `recover_existing_result` 分类项没有 `issueCodes` 字段，`WF_ARCHIVE_*` 码不存在；故 `rc_archive_failure` 的期望码只能是 `[]` —— 正确但**不可断言**。
- 影响：归档失败是真实故障路径，却无法用错误码锁定，只能靠"状态数字"间接验证。
- 处置：`待决`。建议新增 `WF_ARCHIVE_*` 并在该分类项补 `issueCodes`。

### F-24 `WF_REPLAY_KEY_TOO_LONG` 抛裸 `Error`，违反设计决策 D1
- `[缺陷]`。`contracts.ts:1087` 抛裸 `Error`，`workflowIssueCodesOf()`（`:200`）提取不到。
- 处置：`待修（P2）`。改为经 `workflowIssue(...)` 产出，或在 D1 里显式登记该例外。**注意**：改动会使 theme-mini 的对应负样例失效，必须与夹具同批修改。

### F-25 `README.md` §6 把 `recovery-cases.json` 的语义写错
- `[不一致]`。`README.md:129` 第 12 行把它定义为"负样例集（输入 + 指定错误码）"，实际语义是"事件序列 → 期望状态"。
- 处置：`待修（文档）`。夹具已加 `coverage` 块兼容两种读法，但 README 该行应改写。

### F-26 并行编辑导致行号漂移（已由写手校正，教训需固化）
- `[不一致]`。编写期间 `contracts.ts` 的 `validateComicArtifacts()` 及其后整体后移 2 行（`:853→:855`、`:957→:959`、`:1070→:1072`），`fixtures/huozhai-s01/expected-artifacts.json` 后移 34 行；写手已按现测值校正。
- 根因：**我**在并行编写期间修了 `contracts.ts` 的注释语法错误（`fixtures/*/…` 里的 `*/` 提前闭合 JSDoc），导致后续整体位移。
- 教训（固化）：**行号不是稳定锚点，符号名与错误码才是。** 交付物之间应引用 `类名.方法名` / 错误码常量，行号仅作辅助。本文件与 P2 的引用一律以符号为准。

### F-27 负样例断言必须用"包含"而非"等于"
- `[缺陷]`。`fixtures/huozhai-s01/expected-artifacts.json:730-732` 的 `WF_REF_ASSET_NOT_APPROVED` 负样例实测**同时**返回 `["WF_LIMIT_REFERENCES","WF_REF_ASSET_NOT_APPROVED"]`。
- 影响：若 P2 断言写成"恰好等于一个码"，会误判为失败。
- 处置：`待修（P2）`。**P2 全部断言统一采用"包含指定码"语义**；同时复核其它负样例是否也存在多码返回。

### F-28 `readingIndex` 无校验点，阅读顺序只覆盖了一半
- `[缺口]`。`WF_LAYOUT_READING_ORDER_INVALID` 有产出者（`:919` / `:922`），但只校验 `panelPlan` 的 `ordinal`；`pageLayoutSchema.balloons[].readingIndex`（`:763`）**至今没有任何校验点**。
- 影响：气泡阅读顺序可乱而校验放行 —— 漫画可读性在契约层无保障。
- 处置：`待修（P2）`。

---

## 跨文件不一致（由写手报告，需在汇总校验时消解）

| # | 不一致 | 涉及文件 | 处置 |
|---|---|---|---|
| X-1 | `task-templates.v1.json` 的 `inputPlaceholders[].from` 引用被 `workflow-definition.v1.json` 重命名过的步骤 id | 两者 | 汇总校验时逐条比对 |
| X-2 | `panelCandidateSetSchema.candidates[].runId` 存在但 S4 侧无对应字段 | `contracts.ts` | 同 F-01 |
| X-3 | README 的文件索引为 13 个，本文件是新增的第 14 个 | `README.md` | 汇总时更新索引 |

---

## P1 必须给出的答案（来自 Codex 评审的要求）

在 P1 结束前，下列问题必须**有明确答案**，不能留白：

1. 每个生成步骤：输入什么、产出什么、**谁批准**、失败如何分类、怎样恢复。
2. `unknown`（发送结果不确定）**绝不**自动重发、**绝不**换幂等键 —— 必须落到具体错误码与状态。
3. "生成成功" ≠ "结构校验通过" ≠ "人工批准" —— 三者在状态机上必须是三个不同事实。
4. 主角**未绑定**资产版本时，工作流必须阻断还是产出占位符？给出选择与理由。
5. 哪些步骤的失败**阻断完整交付**，哪些允许部分成功。
6. 画布被人工编辑后，已展开的 fan-out 子项如何重算。
7. 陈旧回调（上一个 `generationRevision` 的迟到结果）如何处置。
8. 等待人工审批时**零新增生成调用**如何保证。
9. 并发 fan-out 之间如何避免读到同一份剩余预算。
10. 文本过长（超过 20000 字符上限）时的降级路径。

---

# P1 收口状态（2026-10-16）

**P1 至此冻结。** 目录内共 14 个文件 = 13 份 P1 交付物 + 本发现总账。`apps/`、`packages/`、`prisma/` **未改动一个字节**；`git status` 在本任务范围内只有一条 `?? docs/workflows/`。夹具验证装置复核结果 **FAILURES: 0**。

## 本轮实际改动（仅 3 处，均为 F-22 的联动）

| 文件 | 改动 |
| --- | --- |
| `runtime-semantics.md:46` | `WorkflowRun.status` 增加 `needs_review`，并注明可再入、不属于 `RunStatus` |
| `fixtures/recovery-cases.json` `_note` | 由"枚举不一致、未私自取舍"改为"已裁决、缺口消除" |
| `acceptance-matrix.md` 第 3 条发现 | 标记为已裁决，写明选择"扩充枚举"而非"仅限 step 级"的理由 |

**`contracts.ts` 未做任何行为改动** —— 它不含 status 枚举，F-22 无产出面。这是刻意的：两个夹具（51 项 + 8 项负样例）是针对当前 `contracts.ts` 逐字节验证过的，任何行为改动都会让"已验证"与"新契约"错位。F-24 / F-27 / F-28 的契约改动必须与夹具同批进行，**统一推到 P2**。

## 仍未关闭的项（P2 的输入清单）

**需内容裁决（阻塞 P2，不能由实现者自行决定）**

- **F-21** `WF_STATE_APPROVAL_TARGET_MISMATCH` 被写成 P3 完成标志却无任何覆盖 —— 补负样例，或从完成标志中删除，二者必居其一。**这是当前最该先拍板的一条。**
- **F-23** 归档失败无错误码（`workflow-definition.v1.json:654-658` 缺 `issueCodes`），期望码只能写 `[]`，恢复路径不可断言。建议新增 `WF_ARCHIVE_*`。
- **F-18** 资产包 A 编号不唯一（61 条目 / 53 唯一，8 个重复）——若 P2 解析该资产包，须先定"按编号+标题联合去重"还是"要求源文件修正编号"。
- **F-19** 资产包 A028 自相矛盾（"空场母版"却写"两名手下站位"）——须定"引用该资产时忽略人物描述"的口径。

**待修（P2，工程）**

- **F-24** `contracts.ts:1087` 的 `WF_REPLAY_KEY_TOO_LONG` 抛裸 `Error`，违反 D1（`workflowIssueCodesOf()` 提取不到）。改动会使 theme-mini 对应负样例失效，必须同批改。
- **F-27** 负样例断言必须统一用"包含指定码"而非"等于"（`fixtures/huozhai-s01/expected-artifacts.json:730-732` 实测返回两码）。**这条必须写进 P2 的测试约定，否则测试会假失败。**
- **F-28** `pageLayoutSchema.balloons[].readingIndex` 无任何校验点。
- **F-20** `WF_LIMIT_PROMPT_CHARS` 阈值两处来源（`contracts.ts:959` 字面量 vs `workflow-definition.v1.json` 的 `promptCharLimit`）。
- **14 个无产出者的错误码**：`WF_SCHEMA_VERSION_UNSUPPORTED`、`WF_INPUT_INVALID`、`WF_STABLE_ID_INVALID`、`WF_TASK_TEMPLATE_MISSING`、`WF_MODEL_BINDING_MISSING`、`WF_REF_ASSET_VARIANT_MISSING`、`WF_LIMIT_FOREACH_ITEMS`、`WF_STATE_APPROVAL_DUPLICATE`、`WF_STATE_SEND_UNKNOWN`、`WF_STATE_STEP_REVISION_MISMATCH`、`WF_REPLAY_FINGERPRINT_MISMATCH`、`WF_REPLAY_GENERATION_REVISION_REQUIRED`、`WF_BUDGET_EXCEEDED`、`WF_BUDGET_UNKNOWN_PRICE`。它们的产出者属于**运行时**（P2 才写），不是缺陷；但须在 `contracts.ts` 内为其加显式标注（"产出者：P2 运行时，见 runtime-semantics.md §X"），否则会长期停留在"声明了但没人发"的状态、P2 落地时无人认领。

**待修（文档）**

- **F-25** `README.md:129` §6 第 12 行把 `recovery-cases.json` 写成"负样例集"，实际是"事件序列 → 期望状态"库；夹具已加 `coverage` 块兼容两种读法，但该行应改写。

**已登记、不再追（事实性结论）**

- **F-26** 并行编辑导致行号漂移（根因是我在并行期间修了 `contracts.ts` 的注释语法错误）。**教训：行号不是稳定锚点，符号名与错误码才是。** 后续引用一律以符号为准。
- "火债源文件在任务中被改动"的说法**已证伪**，不要再为此重跑 lineRef 校验（详见上文专节）。

## P2 起点锚（文件摘要，前缀 16 位 sha256）

```
ba1839882b8bcae4  contracts.ts              41982 B
2013082842eb6b30  workflow-definition.v1.json 28211 B
55ee56227da4e678  task-templates.v1.json    27651 B
8413d3cd9f30f042  runtime-semantics.md      45277 B   ← F-22 已改
ea34e929a26b0c49  acceptance-matrix.md      31057 B   ← F-22 已改
fcf913a3cf4bdcdd  README.md                 21635 B
36e5f4747842b133  model-budget-matrix.md    24929 B
36c1cb0ed3687faa  FINDINGS-p1.md            25807 B
```

写手自报"35 个码中 18 个已被夹具覆盖"**未独立复核**（见上文"错误码产出者实测"）。P2 应以"断言真实跑过"为准重新点算，不要沿用这个数字。

## 关于验证装置的已知假阳性

`G:\multimodal-canvas\.tmp\huozhai-fixture-check\checkrefs2.mjs` 会把 `digestSource`（枚举值 `content_key`）误判为"格式非法的摘要字段"，报 14 条 `BAD ... digestSource`。**这是检查脚本按字段名含 `digest` 就要求 64 位 hex 导致的假阳性，不是夹具缺陷** —— `verify.mjs` 的 `PASS digestSource=content_key + 64-hex lowercase digests` 才是正确断言。不要为此改动夹具。（该目录被 `.git/info/exclude:8` 忽略，不污染 `git status`。）
