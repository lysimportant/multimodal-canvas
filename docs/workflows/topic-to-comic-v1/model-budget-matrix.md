# 模型能力与预算矩阵（topic-to-comic v1 / P1）

> 事实来源（唯一）：`contracts.ts`、`workflow-definition.v1.json`、`task-templates.v1.json`（同目录）。
> 本文档是 P1 阶段的**说明性交付物**，不新增任何运行时字段；文中的字段名、步骤 id、错误码一律与上述三份文件逐字一致。
> 状态：draft（与 `workflow-definition.v1.json` 的 `version: "0.1.0"` 对应）。

---

## 0. 范围与前置事实

- 链路形态：`一句主题 → 分页漫画`（`workflow-definition.v1.json:3-6`，`form: "paged-comic"`）。
- 步骤序列：`s0_brief` → `s1_premise` → `s2_script` → `s3_panel_plan` → `s3_asset_manifest` → `s4_asset_candidates` → gate → `s5_render_specs` → `s6_panel_render` → `s7_quality` → `s8_layout` → `s8_render_pages` → gate → `s9_export`。
- 需要「内容生成指令」的步骤共 8 个，全部由 `task-templates.v1.json` 覆盖：
  `s1_premise`、`s2_script`、`s3_panel_plan`、`s3_asset_manifest`、`s4_asset_candidates`、`s6_panel_render`、`s7_quality`、`s8_render_pages`。
- 模板只承载**内容**，不承载控制流：不自由编排、不选择下一步骤、不自行决定返工。步骤顺序、依赖、并发、重试、门禁一律由 `workflow-definition.v1.json` 决定。

---

## 1. 能力矩阵

四类任务所需能力，以及首版（v1 / P1）对每一项的要求。

| 任务类别 | 执行步骤 | 所需能力 | 首版要求 | 缺省时的行为 |
| --- | --- | --- | --- | --- |
| **文字生成** | `s1_premise`、`s2_script`、`s3_panel_plan`、`s3_asset_manifest` | 长上下文改写；严格 JSON 输出（`outputContract.format = "json"`）；稳定 ID 生成（`^[A-Za-z][A-Za-z0-9_-]{0,63}$`）；中文创作；能遵守「禁止字段」清单 | **必需**，缺即阻断 | 报 `WF_MODEL_BINDING_MISSING`（`contracts.ts:128`），不派发任何 `generate` 步骤 |
| **图片生成** | `s4_asset_candidates`、`s6_panel_render` | 文生图；参考图条件（identity / reference conditioning）；固定画幅（`aspectRatio`）；单次可并发出 1..8 张候选 | **必需**，缺即阻断 | 同上，`WF_MODEL_BINDING_MISSING` |
| **视觉评审** | `s7_quality`（视觉部分） | 图像输入；结构化打分与可定位问题输出；能按 `panelId` 一一对应 | **可选，且必须计入预算** | 跳过视觉评审；`visionScore = null`（不是 `false`、不是 `0`），`visionFindings = []`；不消耗 `maxVisionReviews` |
| **页图合成** | `s8_render_pages` | 图像输入；按给定矩形裁切与合成；按给定锚点落版气泡；确定性重现（同输入必同输出） | **必需**，缺即阻断 | 报 `WF_MODEL_BINDING_MISSING`；不允许用「生成式补画」代替合成 |

补充约束：

- **版式几何不属于模型能力**。页与格的矩形、气泡锚点与引线、阅读顺序由 `s8_layout`（`type: "transform"`）确定性产出；`s8_render_pages` 只是执行器。「让模型自己排版」会直接破坏「同一份 `layout` + 同一批入选格图必须产出同一页图」的确定性要求。
- **参考图条件能力目前是未验证项**，不得默认成立；判定方法见第 3 节。
- 文字生成与图片生成不允许互相兜底：文字模型不得被要求出图，图片模型不得被要求补齐剧本或资产清单。

---

## 2. 模型绑定

### 2.1 用别名，不用具体模型名

`comicBriefSchema.modelBindings`（`contracts.ts:336-343`）只接受三个**别名槽位**：

```ts
modelBindings: z.object({
  text:   z.string().min(1),
  image:  z.string().min(1),
  vision: z.string().min(1).optional(),   // 可选；缺失即表示不做自动评审
}).strict()
```

**理由**（与 `contracts.ts:331-335` 的注释一致并展开）：

1. 现网 `ProjectModelDefault` / `AiCredential` 已经把**凭据与模型解耦**——具体模型由项目级默认与凭据决定，不在工作流契约里。
2. 工作流契约要参与**指纹（fingerprint）计算**。一旦把具体模型名写进契约，供应商每次版本升级（`gpt-x` → `gpt-x-2024-xx`）都会让指纹漂移，进而触发 `WF_REPLAY_FINGERPRINT_MISMATCH`，把「供应商改名」误报成「工作流定义被改」。
3. 别名把「我要哪种能力」与「用哪个具体模型」分成两层：契约声明能力需求，运行环境负责解析到具体模型与凭据。

因此：`task-templates.v1.json` 中每个模板只声明 `modelBindingSlot ∈ {text, image, vision}`，不出现任何具体模型名。

### 2.2 槽位缺失处理规则

| 缺失槽位 | 是否阻断 | 错误码 / 行为 |
| --- | --- | --- |
| `text` | **阻断** | `WF_MODEL_BINDING_MISSING`（`contracts.ts:128`）。`s1_premise`、`s2_script`、`s3_panel_plan`、`s3_asset_manifest` 全部无法执行，直接停在解析期，不产生任何供应商请求。 |
| `image` | **阻断** | `WF_MODEL_BINDING_MISSING`。`s4_asset_candidates` 与 `s6_panel_render` 无法执行。特别地：**不得**退化成「只出文字、跳过图」。 |
| `vision` | **不阻断** | 跳过 `s7_quality` 的视觉评审分支。`s7_quality` 照常执行结构检查；输出中 `panels[].visionScore = null`、`panels[].visionFindings = []`。**必须是 `null`，不得写 `false`、不得写 `0`**——`false` 表示「评审了且判定不合格」，`null` 才表示「没有评审」。同时不占用 `maxVisionReviews`，`budget.counters` 中该项保持 0。 |

附加规则：

- **别名解析失败等于槽位缺失**。若 `modelBindings.text` 指向的别名在当前环境的 Provider/凭据配置里不存在，同样报 `WF_MODEL_BINDING_MISSING`；**不得静默回退到任意默认模型**——静默回退会让成本与指纹都失真。
- 槽位是**能力等级**而非模型 id：同一别名可在不同环境解析到不同模型，这本身是设计意图，不算契约漂移。
- `vision` 槽位若存在，是否真的被调用仍受 `s7_quality` 模板的「仅当输入提供了 vision 绑定时才允许调用视觉能力」约束（见 `task-templates.v1.json` 的 `comic-quality-review.v1`）。

---

## 3. 参考图合同与验证方法

### 3.1 当前的能力探测是空壳，不能当作证据

`apps/api/src/resource-mention-capabilities.ts:74` 的 `checkResourceMentionCapabilities()` **当前直接返回 `issues: []`**（`apps/api/src/resource-mention-capabilities.ts:74-83`）。它没有做任何真实的模型能力探测。

因此：

- **不能**据此认为模型支持多角色参考；
- **不能**据此认为模型能在多张参考图之间保持身份一致性；
- **不能**把「这里没有报 issue」当成「适配已通过」。

契约层只约束「只引用**已批准并锁定版本**的资产」（`WF_REF_ASSET_NOT_APPROVED`、`WF_REF_ASSET_VERSION_STALE`，`contracts.ts:135-136`），它约束的是**引用合法性**，不是**模型能不能用**。两者之间存在明确空档，必须靠下面的小样验证填补。

### 3.2 真实适配路径小样验证步骤清单

目的：在真实供应商路径上验证「固定角色参考图 + 2 个角色 + 3 张不同格」的身份保持能力。

1. **准备固定参考图**。取 2 个角色各 1 张已批准参考图（`approved_artifact`，绑定 `assetId` + `version` + `contentDigest`），另备 1 张场景参考图。全部必须已批准且版本锁定，禁止使用未审批候选。
2. **构造 3 张不同格**。三格使用不同 `shotIntent`（例如 `close-up` / `over-shoulder` / `wide`），**每一格都同时引用这 2 个角色 + 该场景**。三格的 `promptText`、`aspectRatio`、`negativePrompt` 按 `renderSpec` 冻结，验证期间不得改动。
3. **每格出 2 个候选**（`maxCandidatesPerItem = 2`），合计 6 张。
4. **人工比对身份保持**。逐张核对：发型与发色、瞳色、面部轮廓、服装细节与材质、体型、标志性道具；场景侧核对光照、色调、关键结构是否与场景参考一致；并核对画幅是否等于 `aspectRatio`。
5. **记录失败模式**（按此清单逐条勾选，便于后续归因）：
   - 身份互换（identity swap）：两角色的特征被交叉拼到同一人身上；
   - 参考图整体复制（copy-paste）：直接把参考图当底图，姿势/构图未随分格变化；
   - 参考丢失（reference drop）：只采纳了其中一张参考图，另一角色退化成文本描述；
   - 画幅不符：实际输出画幅 ≠ `renderSpec.aspectRatio`；
   - 风格漂移：与 `s0_brief.artStyle.preset` 不一致。
6. **通过判据（三条同时成立才算通过）**：
   - identity swap 出现次数 = 0；
   - reference drop 出现次数 = 0；
   - 6 张候选中，人工判定「与参考图属同一角色」的张数 ≥ 5。

### 3.3 验证不通过时的降级路径

按优先级从高到低：

1. **降为单参考图模式**：每格只挂主角 1 张参考图，其余角色靠 `requirementPrompt` 文本特征描述兜底（成本不变，但配角一致性下降）。
2. **把视觉评审提为必需**：将 `modelBindings.vision` 设为必填，用 `s7_quality` 的视觉评审主动抓 identity drift。代价是 `maxVisionReviews` 被真实消耗，且 `visionScore` 不再可能为 `null`。
3. **逐角色分镜再合成**：先分别生成单角色格，再在 `s8_render_pages` 合成层拼合同框。可用性换一致性，代价是牺牲同框演出与镜头自由度。
4. **收敛风格与候选数**：把 `artStyle.preset` 限定到弱化面部身份的风格（如 `ink`、`manga-bw`），同时把 `maxCandidatesPerItem` 提到上限 8，把一致性压力转移给人工挑选。这是最后手段，必须在文档里显式标注为「已降级」。

降级后必须同步更新 `modelBindings` 与 `budget`，并把该 workflow 标记为受限适配；**不得**在代码里静默降级。

---

## 4. 请求数与金额预算

### 4.1 计数器全集（`budgetPolicySchema`，`contracts.ts:270-289`）

| 字段 | 类型 / 取值范围 | 语义 |
| --- | --- | --- |
| `maxTextGenerations` | int `0..10000` | 文字生成次数上限（`s1`/`s2`/`s3_panel_plan`/`s3_asset_manifest`/`s7` 文本部分） |
| `maxImageGenerations` | int `0..10000` | 图片生成次数上限（`s4`/`s6`/`s8_render_pages`） |
| `maxVisionReviews` | int `0..10000` | 视觉评审次数上限；缺 `vision` 槽位时恒为 0 |
| `maxVendorRequests` | int `1..50000` | 供应商**创建请求**总上限（所有槽位、所有重试、所有候选之和）；不可为 0，是唯一硬兜底 |
| `maxRegenerationsPerItem` | int `0..10` | 单个 `itemKey` / `panelId` 的重生成次数上限 |
| `maxCandidatesPerItem` | int `1..8` | 单个 `itemKey` / `panelId` 的单次候选数上限（文档示例取 2） |
| `maxPromptOptimizations` | int `0..1000` | 提示词优化次数上限；受 `allowPromptOptimization`（默认 `false`，`contracts.ts:345`）总开关约束 |
| `amountBudget` | `{ amount: number≥0, currency: string(长度 3) } \| null`，`.strict().nullable()` | 金额预算。**刻意不允许省略**：`null` 表示「本环境没有价格信息」，见第 6 节 |

注意：`workflow-definition.v1.json` 的 `budget.counters` 是 **7 项**，而 `budgetPolicySchema` 是 **8 个字段**——差额是 `amountBudget`，它是金额而不是计数器（见第 9 节差异清单第 4 条）。

### 4.2 示例：1 页 4 格、2 个角色 + 1 个场景

参数假设：`maxCandidatesPerItem = 2`、`maxRegenerationsPerItem = 1`、各步骤 `retryPolicy.maxAttempts = 2`（见 `workflow-definition.v1.json:92,121,159,194,293,417,489,581`）。**每一次尝试都是一次独立的供应商创建请求**，因此重试必须计入 `maxVendorRequests`。

资产单元：`character:linwan@base`、`character:chenxi@base`、`scene:temple@night` → 共 **3 个 `itemKey`**。
分格单元：`page_01` 的 4 个 `panelId` → 共 **4 个**。页单元：1 个 `pageId`。

| 步骤 | 槽位 | 逻辑单元数 | 每单元候选上限 | 首次生成请求 | +1 次重生成 | 小计 | 含 `maxAttempts=2` 的重试上限 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `s1_premise` | text | 1 | 1 | 1 | 0 | 1 | 2 |
| `s2_script` | text | 1 | 1 | 1 | 0 | 1 | 2 |
| `s3_panel_plan` | text | 1 | 1 | 1 | 0 | 1 | 2 |
| `s3_asset_manifest` | text | 1 | 1 | 1 | 0 | 1 | 2 |
| `s4_asset_candidates` | image | 3（2 角色 + 1 场景） | 2 | 6 | 3 | 9 | **18** |
| `s6_panel_render` | image | 4 | 2 | 8 | 4 | 12 | **24** |
| `s7_quality`（文本） | text | 1 | 1 | 1 | 0 | 1 | 2 |
| `s7_quality`（视觉） | vision | 4（每格 1 次） | 1 | 4 | 0 | 4 | 8 |
| `s8_layout` | —（transform，无供应商请求） | 1 | — | 0 | 0 | 0 | 0 |
| `s8_render_pages` | image | 1（每页 1 次合成） | 1 | 1 | 1 | 2 | **4** |
| 提示词优化（若 `allowPromptOptimization = true`） | text | ≤ 9 | 1 | ≤ 9 | 0 | ≤ 9 | ≤ 9 |
| **合计（默认不开提示词优化）** | | | | **24** | **9** | **33** | **≤ 62** |

结论与配额建议（示例工作流）：

- 首次全量生成约 **24** 次创建请求；最坏情况（每单元用满 1 次重生成 + 每单元用满 2 次尝试）**≤ 62** 次。
- 因此该示例必须配置 `maxVendorRequests ≥ 62`；把 `maxVendorRequests` 配成接近首次值（如 24）会在并发 fanout 下**必然误伤**（多个子项同时抢额度）。
- `maxImageGenerations` 至少要覆盖 `s4 + s6 + s8_render_pages` 的 9 + 12 + 2 = **23**（不含重试）到 18 + 24 + 4 = **46**（含重试）。
- `maxTextGenerations ≥ 5`（含重试 10）；`maxVisionReviews ≥ 4`（含重试 8），缺 `vision` 槽位时取 0。
- `s8_layout` 虽然声明了 `maxConcurrency: 2`（`workflow-definition.v1.json:508`），但它是 `transform`，不产生任何供应商请求，**不进入成本预算**。

> 上表口径：`maxAttempts` 是「单个 Run / 单个 fanout 子项」的重试上限，不是全局请求倍数。真实上限应取 `min(各计数器独立上限, maxVendorRequests)`。

---

## 5. 预留与结算

### 5.1 派发前原子预留

- **先预留，后派发**。任何 `generate` / `fanout` 子项在调用供应商**之前**，必须在**同一个事务**内完成预留：
  1. 对目标计数器执行**条件扣减（compare-and-set）**，例如「`UPDATE ... SET remaining = remaining - :delta WHERE remaining >= :delta`」或等价的 `SELECT ... FOR UPDATE` + 更新；
  2. 受影响行数为 0 即视为额度不足 → 抛 `WF_BUDGET_EXCEEDED`（`contracts.ts:166`），**该子项不派发、不调用供应商**；
  3. 同一事务内写入 `reservation` 记录：`reservationId`、`runId`、`stepId`、单元键（fanout 下为 `itemKey` 或 `panelId`）、`counters` 增量、`amount`（可 `null`）、`state = reserved`。
- 预留是**乐观并发安全的条件写**，不是「先读再写」。

### 5.2 终态结算

| 终态 | 计数器 | 金额 | 说明 |
| --- | --- | --- | --- |
| **成功**（`Run.status === succeeded`） | 保留扣减，写 `state = settled` | 供应商回报了金额 → 写实付金额；未回报 → 写 `null` 并保留 `priceUnknown` 标记 | 预估值与实际值的差异计入用量归集；**绝不允许把未知金额落成 0** |
| **失败**（`failed`） | **保守不退回**：请求可能已到达供应商并已计费 | 明确未发出（本地校验失败、连接未建立）→ 标记 `not_billed`；其余标记 `unknown` | 重试会重新走一次预留；`maxRegenerationsPerItem` / `maxAttempts` 是唯一的重试闸门 |
| **取消**（`cancelled`） | 已发出部分按失败处理；**尚未派发**的 fanout 子项必须显式**释放预留**，写 `state = released` | 未发出部分标记 `not_billed` | 禁止静默丢弃预留记录——否则这部分额度永久泄漏 |

> 「成功」只说明供应商返回成功，**不等于**结构校验通过，更**不等于**人工批准。三者是三件不同的事，结算只关心「这次请求花掉了多少」。

### 5.3 禁止并发子项读到同一笔剩余额度

- 所有预留必须走**同一条串行化路径**：同一计数器行的原子条件更新，或同一行上的 `SELECT ... FOR UPDATE`。
- **禁止** `read remaining` → 判断 → `write remaining` 的 read-modify-write 写法。`s4` 与 `s6` 的 `maxConcurrency: 4` 意味着最多 4 个子项同时进入预留；非原子写法会让 4 个子项读到同一笔剩余额度，从而超额派发。
- `reservation` 表需对 `(runId, stepId, unitKey, generationRevision)` 建**唯一约束**，防止同一单元被重复预留（重复派发）。
- 释放与结算必须幂等：同一 `reservationId` 重复结算只生效一次。

---

## 6. 未知价格处理

`amountBudget` 为 `null` 时（`contracts.ts:279-287`），契约明确表示「**本环境没有价格信息**」，而不是「价格为 0」。

规则：

1. **显式标记未知**。任何派发与结算记录都要带 `priceUnknown = true` 语义（或等价的 `amount: null` + 未知标记），一路透传到报告与用量归集。
2. **绝不能显示为零成本**。UI、导出、账单汇总都不允许把 `null` 渲染成 `¥0.00` / `0` / 「免费」。显示必须是「未知」。
3. **由请求数硬上限兜底**。金额不可控时，唯一的安全边界是请求数计数器：`maxVendorRequests`（唯一必填且下限为 1）、`maxTextGenerations`、`maxImageGenerations`、`maxVisionReviews`。这四个必须按第 4 节的算法给出偏保守（接近最坏情况）的取值。
4. `WF_BUDGET_UNKNOWN_PRICE`（`contracts.ts:167`）保留给「**确实需要金额却拿不到金额**」的场景（例如导出结算单、对账）。`amountBudget: null` 本身是**合法配置**，不应因此报错——两者语义必须区分，不能合并。
5. 预留阶段若 `amountBudget === null`，金额维度不做扣减，但仍要写 `reservation` 记录与 `priceUnknown` 标记。
6. 一旦供应商在响应里回报了真实金额，可以把**已结算**金额补成真实值；**预估值在未知时必须保持 `null`**，不得事后反推填充。

---

## 7. 并发限制

### 7.1 复用现有调度，不新建互相冲突的无界调度器

现网只有一条全局并发闸门：`apps/worker/src/generation-concurrency.ts:21` 的 `generationConcurrency`。

- 它每 **1 秒**轮询一次 `queue.getGlobalConcurrency()`；读取配置的超时 `CONFIG_READ_TIMEOUT_MS = 2000`。
- 配置为 `null` 时抛「**生成【并发】配置已丢失，暂停领取并等待管理员重新保存**」，失败路径调用 `worker.pause(true)` 并经 `onError` 上报。
- 它只约束**领取上限**：不取消任务、不改 Provider 状态、不改 Run 状态。

工作流层**不得**绕过它。工作流级 `maxConcurrency` 只能是全局上限之下的**进一步收窄**：

```
effectiveConcurrency(step) = min(全局剩余名额, step.maxConcurrency)
```

### 7.2 步骤级上限（来自 `workflow-definition.v1.json`）

| 步骤 | `maxConcurrency` | 位置 | 是否产生供应商请求 |
| --- | ---: | --- | --- |
| `s4_asset_candidates` | **4** | `workflow-definition.v1.json:265` | 是（image） |
| `s6_panel_render` | **4** | `workflow-definition.v1.json:400` | 是（image） |
| `s8_layout` | **2** | `workflow-definition.v1.json:508` | 否（`transform`，仅本地排版计算） |
| `s8_render_pages` | **2** | `workflow-definition.v1.json:560` | 是（image） |

`foreach` 的展开规模另受 `WF_LIMIT_FOREACH_ITEMS`（`contracts.ts:145`）约束。

### 7.3 补充的三层限制

1. **工作流级上限**：单个 workflow run 同时占用的全局名额不超过该 run 已就绪步骤 `maxConcurrency` 之和，避免一个 run 的 fanout 占满全部名额。
2. **共享凭据 / 模型吞吐**：同一 `AiCredential` 或同一模型别名被多个 run 共享时，必须再按「凭据 + 模型别名」维度设一层信号量。否则 `N 个 run × 4 并发` 会把上游打满，表现为 429 / 超时。该层遇到限流错误必须走正常的 Provider 错误处理与重试语义，**不得静默丢弃**。
3. **公平调度**：多 run 竞争名额时应按 run 轮转（round-robin）或按等待时间加权，而不是让先到 run 的 fanout 一直霸占名额，否则长 workflow 会饿死短 workflow。

> **实现状态**：在 `apps` 下检索 `generationFairness` / `workflowLevel` / `maxConcurrency` **零命中**。也就是说，工作流级上限、凭据级吞吐与跨 run 公平调度**当前都不存在**，上面 7.3 是本阶段需要补齐的缺口，而不是现状描述。

---

## 8. 成本可追溯

- **每个候选必须能追到具体 Run id**。`panelCandidateSetSchema` 的 `candidates[]` 显式带 `runId` 字段（`contracts.ts:661`，注释：「每个候选对应哪一次真实 Run；审计与成本归集用」）。
- `task-templates.v1.json` 的 `comic-panel-render.v1` 把这条写成了硬约束：`runId` 必须是该候选对应的**真实 Run id**，**不得填占位符、不得留空、不得与其他候选复用同一个 `runId`**。
- **审计链路**：`candidateKey → runId → Run → (provider, 模型别名, 凭据, usage, 时间戳) → 费用/用量`。任何一环缺失，该候选即不可审计。
- **用量归集粒度**：按 `(runId, stepId, unitKey)` 聚合，其中 `unitKey` 在 `s4` 是 `itemKey`，在 `s6` 是 `panelId`，在 `s8_render_pages` 是 `pageId`。这样每个候选的成本都能回到「哪一步、哪一个单元、哪一次运行」。
- **红线条**：禁止用「整批一张总账」代替逐候选追溯；禁止把 `runId` 复用到多个候选来掩盖一次请求出多图的情况（一次请求出多图时，每个候选仍需各自的 `runId` 记录，或显式记录同一 `runId` 下的多产物关系）。

---

## 9. 与 `contracts.ts` / `workflow-definition.v1.json` 的不一致之处（仅报告，未改动源文件）

1. **`asset_candidate_set` 缺 `runId`**。`panelCandidateSetSchema.candidates[]` 有 `runId`（`contracts.ts:661`），而 `s4_asset_candidates` 输出的 `asset_candidate_set` 候选结构**没有** `runId`。结果是资产候选（`s4`）无法按第 8 节做成本归集，只有分格候选（`s6`）可以。`comic-asset-render.v1` 模板因此**不能**要求 `runId`。
2. **并发上限的层级无法在契约里表达**。`workflow-definition.v1.json` 只声明了步骤级 `maxConcurrency`（4 / 4 / 2 / 2），而 `generation-concurrency.ts:21` 是单一全局上限；契约里没有「工作流级」或「凭据级」并发字段，第 7.3 节的三层关系目前无处声明。
3. **`transform` 步骤也带 `maxConcurrency`**。`s8_layout` 是 `type: "transform"` 却有 `maxConcurrency: 2`（`workflow-definition.v1.json:508`）。它不产生供应商请求，与其他步骤的 `maxConcurrency` 语义不同，容易被误读为成本参数。
4. **计数器数量不一致**。`workflow-definition.v1.json` 的 `budget.counters` 是 7 项，`budgetPolicySchema` 是 8 个字段——差额 `amountBudget` 是金额而非计数器。若 `budget.counters` 会被单独校验，则 `amountBudget` 在该处无处声明。
5. **能力探测与参考图合同之间存在空档**。契约要求「只引用已批准资产」（`WF_REF_ASSET_NOT_APPROVED` / `WF_REF_ASSET_VERSION_STALE`），但 `apps/api/src/resource-mention-capabilities.ts:74` 的 `checkResourceMentionCapabilities()` 直接返回 `issues: []`，没有任何一处校验模型是否真的接受多张参考图。第 3 节的小样验证是当前唯一的填补手段。
6. **`maxVisionReviews` 的计数粒度未定义**。`s7_quality` 在 `workflow-definition.v1.json` 里是普通的 `type: "generate"` 步骤（非 `fanout`），而 `quality_report.panels[]` 与 `panelCandidates` 一一对应，一个 Run 内可能发起多次视觉调用。「一次视觉评审」是按 Run 计还是按格计，契约没有写明，直接影响第 4 节表格里视觉评审的取值口径。
7. **`maxRegenerationsPerItem` 缺触发主体字段**。契约里有 `WF_REPLAY_GENERATION_REVISION_REQUIRED`（`contracts.ts:162`）与 `generationRevision`，但没有声明「谁有权发起重生成、以什么记录授权」。模板只能反向禁止模型自行递增，重生成必须由人工触发的路径在契约中不可见。
8. **`WF_BUDGET_UNKNOWN_PRICE` 与 `amountBudget: null` 的语义边界未写明**。`budgetPolicySchema` 允许 `amountBudget: null`（合法配置），错误码表里又有 `WF_BUDGET_UNKNOWN_PRICE`。二者何时该报错的边界（配置期 vs 结算期）在 `contracts.ts` 中没有说明，第 6 节第 4 条是本文档给出的解释性约定。

以上 8 条均**只报告**，未修改 `contracts.ts` 或 `workflow-definition.v1.json`。
