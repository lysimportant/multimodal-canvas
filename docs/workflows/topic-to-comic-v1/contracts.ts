/**
 * topic-to-comic@0.1.0 —— P1 契约草案（DRAFT）
 * ============================================================================
 *
 * 状态：**草案，尚未接入任何包。** 本文件位于 docs/ 下，不被 apps/* 或
 * packages/* 导入。评审通过后再迁入 `packages/domain/src/workflow/`。
 *
 * 为什么单独起草而不是直接写进 packages/domain：
 *   packages/domain/src/index.ts 是 97KB 的单文件，画布、运行快照、提示词文档
 *   全在里面。先把契约在同构草案里跑通（含正/负样例），再决定拆分边界，
 *   避免评审未定时就动领域包的导出面。
 *
 * 依赖：zod ^3.24.2（与 packages/domain 一致）。
 *
 * ---------------------------------------------------------------------------
 * 与现有代码的关系（重要，避免重复造轮子）
 * ---------------------------------------------------------------------------
 * 本文件**不**重新定义画布、运行快照、提示词文档。以下一律复用：
 *
 *   canvasDocumentSchema        packages/domain/src/index.ts:1074
 *   canvasNodeSchema            packages/domain/src/index.ts:1010
 *   canvasEdgeSchema            packages/domain/src/index.ts:1038
 *   canvasGroupSchema           packages/domain/src/index.ts:1062
 *   isPortConnectionAllowed     packages/domain/src/index.ts:1127（连线兼容性唯一判据）
 *   promptDocumentSchema        packages/domain/src/index.ts:305  （正文 20,000 字符上限，见 :330）
 *   runSnapshotSchema           packages/domain/src/index.ts:1304
 *   stableSnapshot              packages/domain/src/index.ts:1528
 *   runSnapshotFingerprintMaterial  packages/domain/src/index.ts:1537
 *   workflowNodeStateSchema     packages/domain/src/index.ts:1603
 *   workflowStateSchema         packages/domain/src/index.ts:1620
 *   runRecordSchema             packages/domain/src/index.ts:1638
 *   EXPORT_SCHEMA_VERSION = 1   apps/api/src/export.ts:7
 *   Run.idempotencyKey 长度上限 200   packages/domain/src/index.ts:1651
 *   Run @@unique([projectId, idempotencyKey])   prisma/schema.prisma:382
 *   AssetVersion @@unique([assetId, version])   prisma/schema.prisma:330
 *
 * 本文件新增的是**漫画生产链路的产物契约**，即现有领域包里不存在的那一层。
 *
 * ---------------------------------------------------------------------------
 * 设计决定（每条都有理由，评审时请针对理由反驳）
 * ---------------------------------------------------------------------------
 * D1. 错误码与人类文案分离。
 *     现有画布校验把人类文案直接塞进 message（如
 *     `canvas graph must be acyclic`，index.ts:1156），调用方无法可靠分支。
 *     本文件所有校验错误都带 `params.workflowIssueCode`，文案可随时改。
 *
 * D2. 稳定 ID 与展示名分离。
 *     itemKey / panelId / entityId 只用 [A-Za-z][A-Za-z0-9_-]，禁止中文、
 *     禁止数组下标。理由：Codex 评审指出数组下标会在重排后指向错误对象，
 *     而展示名允许用户随时改。
 *
 * D3. 指纹计算与哈希算法解耦（依赖注入）。
 *     `computeInputFingerprintMaterial()` 只产出规范 JSON 字符串，
 *     `inputFingerprint()` 接收 hasher。理由：packages/domain 同时被 web 侧
 *     引用，直接 import 'node:crypto' 会污染浏览器构建。哈希算法可换，
 *     指纹材料不可换 —— 材料变了，所有历史幂等键都失效。
 *
 * D4. 三种输入语义显式化（literal_text / generated_artifact / approved_artifact）。
 *     现状：connected-image-results.ts:55 取“最近成功结果”，
 *     connected-text-inputs.ts:63 甚至能把上游提示词当正文。
 *     二者都不等于“人工批准”。契约必须能表达这个差别。
 *
 * D5. ApprovedAssetRef 携带 contentDigest，不只带 assetId + version。
 *     AssetVersion 已有 sha256 字段（prisma/schema.prisma:322，可空）。
 *     可空意味着不能假设它存在；contentDigest 允许在 sha256 缺失时回退到
 *     contentKey，但必须显式记录用的是哪一个（见 AssetDigestSource）。
 *
 * D6. 生成修订（generationRevision）与技术重试（attempt）是两个维度。
 *     “再画一张”是前者，网络重试是后者。混用会导致换幂等键重发 = 重复付费。
 */

import { z } from 'zod';

/** 契约版本。任何字段语义变更都必须提升它，并保留旧版本解析器。 */
export const CONTRACT_SCHEMA_VERSION = 1 as const;

// ===========================================================================
// 1. 基础标量
// ===========================================================================

/**
 * 稳定 ID。刻意排除中文与空白：这些 ID 会进入幂等键并被 URL 携带。
 * 上限 64 与 Run.idempotencyKey 的 200 字符上限配合（见 §5 长度预算）。
 */
export const stableIdSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/, {
    message: '稳定 ID 必须以字母开头，且只含 A-Za-z0-9_-（不超过 64 字符）',
  });

/** sha256 十六进制摘要。 */
export const sha256HexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, { message: 'sha256 必须是小写十六进制 64 位' });

/** 生成修订号：用户主动“再画一张”增加它，网络重试不增加。 */
export const generationRevisionSchema = z.number().int().min(1).max(1_000);

/** ISO-8601 时间。与 runRecordSchema 的用法一致。 */
export const isoDateTimeSchema = z.string().datetime();

/** 1..N 的自增序号，仅用于页内/集内排序，**不得**用作身份。 */
export const ordinalSchema = z.number().int().min(0).max(9_999);

// ===========================================================================
// 2. 稳定错误码
// ===========================================================================

/**
 * 机器可识别的错误码。比现有 ZodIssueCode.custom + 自由文案更严格：
 * 每个码对应一个可测试的失败场景，acceptance-matrix.md 逐个覆盖。
 *
 * 命名规则：WF_<阶段或对象>_<失败性质>
 *  - SCHEMA_  解析期（结构不合法，无法继续）
 *  - REF_     跨对象引用悬空
 *  - LIMIT_   超出声明上限
 *  - STATE_   状态机/审批时序错误
 *  - REPLAY_  幂等与重放语义
 *  - BUDGET_  预算与用量
 */
export const WORKFLOW_ISSUE_CODES = [
  // --- 解析期 ---
  'WF_SCHEMA_VERSION_UNSUPPORTED',
  'WF_INPUT_INVALID',
  'WF_STABLE_ID_INVALID',
  'WF_DUPLICATE_STABLE_ID',
  'WF_TASK_TEMPLATE_MISSING',
  'WF_MODEL_BINDING_MISSING',

  // --- 跨对象引用 ---
  'WF_REF_DANGLING',
  'WF_REF_UNKNOWN_SPEAKER',
  'WF_REF_ITEM_KEY_INVALID',
  'WF_REF_ASSET_VARIANT_MISSING',
  'WF_REF_ASSET_NOT_APPROVED',
  'WF_REF_ASSET_VERSION_STALE',

  // --- 上限 ---
  'WF_LIMIT_CHARACTERS',
  'WF_LIMIT_SCENES',
  'WF_LIMIT_PAGES',
  'WF_LIMIT_PANELS',
  'WF_LIMIT_REFERENCES',
  'WF_LIMIT_PROMPT_CHARS',
  'WF_LIMIT_FOREACH_ITEMS',

  // --- 排版 ---
  'WF_LAYOUT_RECT_INVALID',
  'WF_LAYOUT_PANEL_MISSING',
  'WF_LAYOUT_BALLOON_OVERFLOW',
  'WF_LAYOUT_READING_ORDER_INVALID',

  // --- 状态与审批 ---
  'WF_STATE_APPROVAL_STALE',
  'WF_STATE_APPROVAL_TARGET_MISMATCH',
  'WF_STATE_APPROVAL_DUPLICATE',
  'WF_STATE_SEND_UNKNOWN',
  'WF_STATE_STEP_REVISION_MISMATCH',

  // --- 幂等与重放 ---
  'WF_REPLAY_FINGERPRINT_MISMATCH',
  'WF_REPLAY_GENERATION_REVISION_REQUIRED',
  'WF_REPLAY_KEY_TOO_LONG',

  // --- 预算 ---
  'WF_BUDGET_EXCEEDED',
  'WF_BUDGET_UNKNOWN_PRICE',

  // --- 导出 ---
  'WF_EXPORT_INCOMPLETE',
  'WF_EXPORT_VERSION_MISMATCH',
] as const;

export type WorkflowIssueCode = (typeof WORKFLOW_ISSUE_CODES)[number];

/**
 * 构造一个携带稳定错误码的 Zod issue。
 *
 * 用 `params` 而不是把码拼进 message：message 面向用户（可本地化、可改写），
 * params.workflowIssueCode 面向调用方（不可改）。Zod 的 CustomIssue 允许
 * 任意 params（zod 3 的 ZodCustomIssue 定义带 `params?: any`）。
 */
export function workflowIssue(
  code: WorkflowIssueCode,
  message: string,
  path?: (string | number)[],
): z.IssueData {
  return {
    code: z.ZodIssueCode.custom,
    message,
    path: path ?? [],
    params: { workflowIssueCode: code },
  };
}

/**
 * 从 ZodError 中提取稳定错误码。
 * 调用方据此分支，绝不解析 message 文本。
 */
export function workflowIssueCodesOf(error: z.ZodError): WorkflowIssueCode[] {
  const codes = new Set<WorkflowIssueCode>();
  for (const issue of error.issues) {
    const code = (issue as { params?: { workflowIssueCode?: unknown } }).params
      ?.workflowIssueCode;
    if (typeof code === 'string' && (WORKFLOW_ISSUE_CODES as readonly string[]).includes(code)) {
      codes.add(code as WorkflowIssueCode);
    }
  }
  return [...codes];
}

// ===========================================================================
// 3. 三种输入语义（D4）
// ===========================================================================

/**
 * literal_text —— 用户直接提供的正文，不来自任何生成。
 * 例：用户手写的主题一句话。
 */
export const literalTextRefSchema = z
  .object({
    kind: z.literal('literal_text'),
    text: z.string().min(1),
  })
  .strict();

/**
 * generated_artifact —— 必须来自**成功**生成且通过结构校验的产物。
 * 注意：Run.status === succeeded 不等于本步骤成功；结构校验是独立的一关。
 */
export const generatedArtifactRefSchema = z
  .object({
    kind: z.literal('generated_artifact'),
    stepRunId: stableIdSchema,
    artifactSchema: z.string().min(1),
    artifactDigest: sha256HexSchema,
  })
  .strict();

/**
 * approved_artifact —— 必须来自**有效人工审批**的指定版本。
 * 这是角色一致性链条的唯一可信来源（Codex 风险 #3）。
 */
export const approvedArtifactRefSchema = z
  .object({
    kind: z.literal('approved_artifact'),
    approvalId: stableIdSchema,
    assetId: stableIdSchema,
    version: z.number().int().min(1),
    contentDigest: sha256HexSchema,
  })
  .strict();

export const artifactInputRefSchema = z.discriminatedUnion('kind', [
  literalTextRefSchema,
  generatedArtifactRefSchema,
  approvedArtifactRefSchema,
]);

export type ArtifactInputRef = z.infer<typeof artifactInputRefSchema>;

// ===========================================================================
// 4. S0 —— ComicBrief（范围与预检）
// ===========================================================================

/**
 * 预算只记“金额”是不够的（Codex §2G）：
 * 未知价格必须显式表达为 unknown，由请求数硬上限兜底，绝不能显示为 0 成本。
 */
export const budgetPolicySchema = z
  .object({
    maxTextGenerations: z.number().int().min(0).max(10_000),
    maxImageGenerations: z.number().int().min(0).max(10_000),
    maxVisionReviews: z.number().int().min(0).max(10_000),
    maxVendorRequests: z.number().int().min(1).max(50_000),
    maxRegenerationsPerItem: z.number().int().min(0).max(10),
    maxCandidatesPerItem: z.number().int().min(1).max(8),
    maxPromptOptimizations: z.number().int().min(0).max(1_000),
    /**
     * 金额预算。`null` 表示“本环境没有价格信息”。
     * 刻意不允许省略：调用方必须明确选择“我不知道价格”，
     * 而不是默认零成本。
     */
    amountBudget: z
      .object({ amount: z.number().nonnegative(), currency: z.string().length(3) })
      .strict()
      .nullable(),
  })
  .strict();

export const productionLimitsSchema = z
  .object({
    maxCharacters: z.number().int().min(1).max(200),
    maxScenes: z.number().int().min(1).max(200),
    maxProps: z.number().int().min(0).max(500),
    maxPages: z.number().int().min(1).max(200),
    maxPanelsPerPage: z.number().int().min(1).max(24),
    maxReferencesPerPanel: z.number().int().min(0).max(8),
    maxProfileVariantsPerEntity: z.number().int().min(1).max(20),
  })
  .strict();

export const comicBriefSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    /** 用户给的一句话主题。这是整条链路的真实入口。 */
    theme: z.string().trim().min(1).max(200),
    /**
     * 题材由输入决定，不设默认值。
     * 刻意不用 z.enum：现有 screenplay-xianxia 等 Skill 是题材模板，
     * 不是题材全集；把题材做成闭集会在第一次遇到新题材时要求改契约。
     */
    genre: z.string().trim().min(1).max(40),
    artStyle: z
      .object({
        preset: z.enum(['manga-bw', 'manga-screentone', 'color-anime', 'watercolor', 'ink']),
        notes: z.string().max(500).optional(),
      })
      .strict(),
    pageShape: z
      .object({
        pageCount: z.number().int().min(1).max(200),
        panelsPerPage: z.number().int().min(1).max(24),
        readingDirection: z.enum(['rtl', 'ltr']),
      })
      .strict(),
    language: z.string().min(2).max(20).default('zh-CN'),
    audienceRating: z.enum(['general', 'teen', 'mature']),
    budget: budgetPolicySchema,
    limits: productionLimitsSchema,
    /**
     * 模型绑定使用别名而非具体模型名。
     * 理由：现有 ProjectModelDefault / AiCredential 已经把凭据与模型解耦，
     * 契约里写死模型名会让指纹随供应商版本漂移。
     */
    modelBindings: z
      .object({
        text: z.string().min(1),
        image: z.string().min(1),
        // 视觉评审是可选的，且必须计入预算；缺失即表示不做自动评审。
        vision: z.string().min(1).optional(),
      })
      .strict(),
    /** 是否允许调用提示词优化（默认否，避免额外成本与不必要的变化）。 */
    allowPromptOptimization: z.boolean().default(false),
  })
  .strict();

export type ComicBrief = z.infer<typeof comicBriefSchema>;

// ===========================================================================
// 5. S1/S2 —— 故事与剧本
// ===========================================================================

export const storyPremiseSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    logline: z.string().trim().min(1).max(300),
    synopsis: z.string().trim().min(1).max(4_000),
    toneTags: z.array(z.string().min(1).max(20)).max(8),
    /** 必须落在 brief.maxCharacters 之内，交叉校验在 validateComicArtifacts 里做。 */
    characters: z
      .array(
        z
          .object({
            characterId: stableIdSchema,
            displayName: z.string().trim().min(1).max(40),
            storyRole: z.enum(['protagonist', 'antagonist', 'supporting', 'cameo']),
            oneLine: z.string().trim().min(1).max(200),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export type StoryPremise = z.infer<typeof storyPremiseSchema>;

export const comicScriptSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    /** 对白是独立实体并可被格引用；不是面板里的裸字符串。 */
    dialogues: z
      .array(
        z
          .object({
            dialogueId: stableIdSchema,
            speakerCharacterId: stableIdSchema,
            text: z.string().trim().min(1).max(200),
            intent: z.enum(['speech', 'shout', 'whisper', 'inner', 'narration']),
          })
          .strict(),
      )
      .max(2_000),
    beats: z
      .array(
        z
          .object({
            beatId: stableIdSchema,
            sceneId: stableIdSchema,
            summary: z.string().trim().min(1).max(300),
            participantCharacterIds: z.array(stableIdSchema).max(20),
            dialogueIds: z.array(stableIdSchema).max(20),
          })
          .strict(),
      )
      .min(1)
      .max(2_000),
  })
  .strict();

export type ComicScript = z.infer<typeof comicScriptSchema>;

// ===========================================================================
// 6. S3 —— 页格规划与资产需求
// ===========================================================================

export const panelSchema = z
  .object({
    panelId: stableIdSchema,
    ordinal: ordinalSchema,
    beatId: stableIdSchema,
    sceneId: stableIdSchema,
    /** 刻意不用 z.string() 自由文本：列出的是可枚举的镜头意图，不是运镜脚本。 */
    shotIntent: z.enum([
      'establishing',
      'wide',
      'medium',
      'close-up',
      'extreme-close-up',
      'over-shoulder',
      'insert',
      'reaction',
      'transition',
    ]),
    visualDirection: z.string().trim().min(1).max(600),
    characterIds: z.array(stableIdSchema).max(20),
    dialogueIds: z.array(stableIdSchema).max(20),
    /** 旁白/拟声词等非对白文字，与 dialogues 分开，避免污染说话人。 */
    captionText: z.string().max(200).optional(),
  })
  .strict();

export const pagePlanSchema = z
  .object({
    pageId: stableIdSchema,
    ordinal: ordinalSchema,
    panels: z.array(panelSchema).min(1).max(24),
  })
  .strict();

export const panelPlanSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    pages: z.array(pagePlanSchema).min(1).max(200),
  })
  .strict();

export type PanelPlan = z.infer<typeof panelPlanSchema>;

/**
 * 资产需求的 itemKey 格式。**禁止数组下标**（D2）。
 * 形如 `character:linwan@base` / `scene:temple@night` / `prop:jade@broken`
 */
export const assetItemKeySchema = z
  .string()
  .regex(/^(character|scene|prop|style):[A-Za-z][A-Za-z0-9_-]{0,63}@[A-Za-z][A-Za-z0-9_-]{0,63}$/, {
    message:
      'itemKey 必须形如 <kind>:<entityId>@<variantId>，且不得使用数组下标或可改展示名',
  });

/**
 * 状态变体是独立的 variantId，而不是“同一张脸换了描述”。
 * 年龄、服装、损伤状态都必须各自成为一个 variant（Codex §2E）。
 */
export const assetRequirementSchema = z
  .object({
    itemKey: assetItemKeySchema,
    kind: z.enum(['character', 'scene', 'prop', 'style']),
    entityId: stableIdSchema,
    variantId: stableIdSchema,
    displayName: z.string().trim().min(1).max(60),
    /** 描述该变体的差异点。base 变体可为空。 */
    variantDelta: z.string().max(400).optional(),
    requirementPrompt: z.string().trim().min(1).max(2_000),
    /** 引用哪些其他 itemKey 作为视觉参考（如角色服装引用该角色的 base）。 */
    referenceItemKeys: z.array(assetItemKeySchema).max(8),
  })
  .strict();

export const assetManifestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    items: z.array(assetRequirementSchema).min(1).max(500),
  })
  .strict();

export type AssetManifest = z.infer<typeof assetManifestSchema>;

// ===========================================================================
// 7. S4 —— 已批准资产引用
// ===========================================================================

/**
 * sha256 与 contentKey 的取舍必须显式记录来源，不能悄悄回退（D5）。
 * AssetVersion.sha256 可空（prisma/schema.prisma:322）。
 */
export const assetDigestSourceSchema = z.enum(['asset_version_sha256', 'content_key']);

export const approvedAssetRefSchema = z
  .object({
    itemKey: assetItemKeySchema,
    entityId: stableIdSchema,
    variantId: stableIdSchema,
    assetId: stableIdSchema,
    version: z.number().int().min(1),
    contentDigest: sha256HexSchema,
    digestSource: assetDigestSourceSchema,
    approvalId: stableIdSchema,
    approvedBy: stableIdSchema,
    approvedAt: isoDateTimeSchema,
    /** 候选集快照摘要：审批时到底在哪些候选里选的。 */
    candidateSetDigest: sha256HexSchema,
  })
  .strict();

export type ApprovedAssetRef = z.infer<typeof approvedAssetRefSchema>;

export const assetCandidateSetSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    itemKey: assetItemKeySchema,
    generationRevision: generationRevisionSchema,
    candidates: z
      .array(
        z
          .object({
            candidateKey: stableIdSchema,
            assetId: stableIdSchema,
            version: z.number().int().min(1),
            contentDigest: sha256HexSchema,
            digestSource: assetDigestSourceSchema,
          })
          .strict(),
      )
      .min(1)
      .max(8),
  })
  .strict();

export type AssetCandidateSet = z.infer<typeof assetCandidateSetSchema>;

// ===========================================================================
// 8. 审批（gate）
// ===========================================================================

/**
 * gate 不是一个 `awaiting_confirmation` 状态位（Codex §2C）。
 * 它必须携带：审批对象、决定、并发前置条件、重放语义。
 */
export const approvalDecisionSchema = z
  .object({
    approvalId: stableIdSchema,
    workflowRunId: stableIdSchema,
    stepId: stableIdSchema,
    /**
     * 并发前置条件：审批提交时客户端认为步骤处在哪个修订。
     * 不匹配 -> WF_STATE_APPROVAL_STALE，绝不静默接受。
     */
    expectedStepRevision: z.number().int().min(0),
    /** 审批对象必须锁定到具体产物修订，而不是“当前显示的东西”。 */
    targetKind: z.enum(['asset_candidate', 'panel_candidate', 'page_render', 'story_scope']),
    targetItemKey: assetItemKeySchema.or(z.string().min(1).max(80)),
    targetArtifactDigest: sha256HexSchema,
    decision: z.enum(['approved', 'rejected']),
    /** approved 且存在多个候选时必填。 */
    selectedCandidateKey: stableIdSchema.optional(),
    actorId: stableIdSchema,
    decidedAt: isoDateTimeSchema,
    reason: z.string().max(500).optional(),
    /**
     * 重放标识：同一个 approvalId 重复提交必须无副作用。
     * 由客户端生成并持久化，不是每次请求新生成。
     */
    decisionIdempotencyKey: z.string().trim().min(1).max(200),
  })
  .strict()
  .superRefine((decision, context) => {
    if (decision.decision === 'approved' && !decision.selectedCandidateKey) {
      context.addIssue(
        workflowIssue(
          'WF_STATE_APPROVAL_TARGET_MISMATCH',
          '批准时必须指定 selectedCandidateKey：批准的是某个具体候选，不是“这一类东西”',
          ['selectedCandidateKey'],
        ),
      );
    }
    // 批准故事范围时不存在候选（只有一个产物），例外放行。
    if (
      decision.decision === 'approved' &&
      !decision.selectedCandidateKey &&
      decision.targetKind !== 'story_scope'
    ) {
      context.addIssue(
        workflowIssue(
          'WF_STATE_APPROVAL_TARGET_MISMATCH',
          '只有 story_scope 允许不指定候选',
          ['selectedCandidateKey'],
        ),
      );
    }
  });

export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

// ===========================================================================
// 9. S5/S6/S7 —— 渲染规格、出图、质检
// ===========================================================================

export const panelRenderSpecSchema = z
  .object({
    panelId: stableIdSchema,
    pageId: stableIdSchema,
    generationRevision: generationRevisionSchema,
    /** 已裁剪的提示词正文。跨对象总量受 WF_LIMIT_PROMPT_CHARS 约束。 */
    promptText: z.string().trim().min(1),
    negativePrompt: z.string().max(2_000).optional(),
    aspectRatio: z.enum(['1:1', '3:4', '4:3', '16:9', '9:16']),
    /** 只允许已批准资产进入，且引用数受 brief.limits.maxReferencesPerPanel 约束。 */
    referenceAssetRefs: z.array(approvedAssetRefSchema).max(8),
    /** 冻结的模型绑定与显式参数，进入指纹。 */
    modelAlias: z.string().min(1),
    resolvedParameters: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
    seed: z.number().int().optional(),
  })
  .strict();

export type PanelRenderSpec = z.infer<typeof panelRenderSpecSchema>;

export const panelRenderSpecSetSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    specs: z.array(panelRenderSpecSchema).min(1),
  })
  .strict();

export const panelCandidateSetSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    panelId: stableIdSchema,
    generationRevision: generationRevisionSchema,
    candidates: z
      .array(
        z
          .object({
            candidateKey: stableIdSchema,
            assetId: stableIdSchema,
            version: z.number().int().min(1),
            contentDigest: sha256HexSchema,
            /** 每个候选对应哪一次真实 Run；审计与成本归集用。 */
            runId: stableIdSchema,
          })
          .strict(),
      )
      .min(1)
      .max(8),
  })
  .strict();

/**
 * 结构检查与人工审核是两条独立记录。
 * `structural.passed` 为 true 不代表用户认可画面（Codex §2C）。
 */
export const qualityReportSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    panels: z
      .array(
        z
          .object({
            panelId: stableIdSchema,
            structural: z
              .object({
                hasImage: z.boolean(),
                aspectRatioMatches: z.boolean(),
                referenceCountWithinLimit: z.boolean(),
                /** 自动视觉评审结果；未启用评审时为 null，而不是 false。 */
                visionScore: z.number().min(0).max(1).nullable(),
                visionFindings: z.array(z.string().max(200)).max(20),
              })
              .strict(),
            manual: z
              .object({
                verdict: z.enum(['accepted', 'rework']),
                notes: z.string().max(500),
                reviewedBy: stableIdSchema,
                reviewedAt: isoDateTimeSchema,
              })
              .strict()
              .nullable(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export type QualityReport = z.infer<typeof qualityReportSchema>;

// ===========================================================================
// 10. S8/S9 —— 排版与成品导出
// ===========================================================================

export const rectSchema = z
  .object({
    x: z.number().min(0),
    y: z.number().min(0),
    width: z.number().positive(),
    height: z.number().positive(),
  })
  .strict();

export const pageLayoutSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    pageId: stableIdSchema,
    ordinal: ordinalSchema,
    canvas: z
      .object({
        width: z.number().int().positive().max(20_000),
        height: z.number().int().positive().max(20_000),
        unit: z.literal('px'),
      })
      .strict(),
    /**
     * 排版坐标属于**内容输入**，必须进指纹（Codex §2B 明确指出不能排除）。
     * 画布上的节点位置才不进指纹。
     */
    panels: z
      .array(
        z
          .object({
            panelId: stableIdSchema,
            rect: rectSchema,
            cropMode: z.enum(['cover', 'contain', 'fit-width', 'fit-height']),
            zIndex: z.number().int().min(0).max(999),
          })
          .strict(),
      )
      .min(1),
    balloons: z
      .array(
        z
          .object({
            balloonId: stableIdSchema,
            dialogueId: stableIdSchema,
            panelId: stableIdSchema,
            shape: z.enum(['speech', 'thought', 'shout', 'whisper', 'narration-box']),
            anchor: z.object({ x: z.number(), y: z.number() }).strict(),
            tailTarget: z.object({ x: z.number(), y: z.number() }).strict().nullable(),
            text: z.string().min(1).max(200),
            fontSize: z.number().int().min(6).max(200),
            readingIndex: ordinalSchema,
          })
          .strict(),
      )
      .max(500),
  })
  .strict();

export type PageLayout = z.infer<typeof pageLayoutSchema>;

export const renderedPageSetSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    pages: z
      .array(
        z
          .object({
            pageId: stableIdSchema,
            ordinal: ordinalSchema,
            assetId: stableIdSchema,
            version: z.number().int().min(1),
            contentDigest: sha256HexSchema,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

/**
 * 成品清单。只列**本次批准**的版本（Codex §2H）。
 * 刻意不复用 EXPORT_SCHEMA_VERSION（apps/api/src/export.ts:7）：
 * 那是工作流搬运格式的版本，语义不同，混用会让回滚互相牵连。
 */
export const comicExportManifestSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    workflowRunId: stableIdSchema,
    definitionId: z.literal('topic-to-comic'),
    definitionVersion: z.string().min(1),
    definitionDigest: sha256HexSchema,
    briefDigest: sha256HexSchema,
    pages: z
      .array(
        z
          .object({
            pageId: stableIdSchema,
            ordinal: ordinalSchema,
            imageAssetId: stableIdSchema,
            imageVersion: z.number().int().min(1),
            imageDigest: sha256HexSchema,
            panelCandidates: z
              .array(
                z
                  .object({
                    panelId: stableIdSchema,
                    assetId: stableIdSchema,
                    version: z.number().int().min(1),
                    contentDigest: sha256HexSchema,
                  })
                  .strict(),
              )
              .min(1),
          })
          .strict(),
      )
      .min(1),
    /** 被排除的格必须留痕；不能悄悄少一页（Codex 风险 #8）。 */
    excludedPanels: z
      .array(
        z.object({ panelId: stableIdSchema, reason: z.string().min(1).max(300) }).strict(),
      )
      .default([]),
    generatedAt: isoDateTimeSchema,
    approvedAt: isoDateTimeSchema,
  })
  .strict();

export type ComicExportManifest = z.infer<typeof comicExportManifestSchema>;

// ===========================================================================
// 11. 跨对象校验（单对象 schema 表达不了的关系）
// ===========================================================================

/**
 * 校验整条产物链的引用完整性。
 *
 * 这个函数是 P1 的核心可测单元：它必须对每个夹具的 expected-artifacts.json
 * 全部通过，对夹具内的负样例（negativeCases）给出**指定**错误码。
 *
 * 注意：本注释里不要出现斜杠加星号的字符组合，否则会提前终止块注释。
 */
export function validateComicArtifacts(input: {
  brief: ComicBrief;
  premise: StoryPremise;
  script: ComicScript;
  panelPlan: PanelPlan;
  assetManifest: AssetManifest;
  approvedRefs: ApprovedAssetRef[];
  renderSpecs: PanelRenderSpec[];
  layouts: PageLayout[];
  exportManifest?: ComicExportManifest;
}): WorkflowIssueCode[] {
  const codes = new Set<WorkflowIssueCode>();
  const add = (code: WorkflowIssueCode) => codes.add(code);

  const { brief, premise, script, panelPlan, assetManifest, approvedRefs, renderSpecs, layouts } =
    input;

  // --- 角色与场景上限 ---
  const characterIds = new Set(premise.characters.map((c) => c.characterId));
  if (characterIds.size > brief.limits.maxCharacters) add('WF_LIMIT_CHARACTERS');

  const sceneIds = new Set(script.beats.map((b) => b.sceneId));
  if (sceneIds.size > brief.limits.maxScenes) add('WF_LIMIT_SCENES');

  // --- 唯一性 ---
  const seen = new Set<string>();
  const unique = (id: string, kind: string) => {
    const key = `${kind}:${id}`;
    if (seen.has(key)) add('WF_DUPLICATE_STABLE_ID');
    seen.add(key);
  };
  premise.characters.forEach((c) => unique(c.characterId, 'character'));
  script.dialogues.forEach((d) => unique(d.dialogueId, 'dialogue'));
  script.beats.forEach((b) => unique(b.beatId, 'beat'));
  panelPlan.pages.forEach((p) => {
    unique(p.pageId, 'page');
    p.panels.forEach((panel) => unique(panel.panelId, 'panel'));
  });

  // --- 对白说话人必须存在 ---
  for (const dialogue of script.dialogues) {
    if (!characterIds.has(dialogue.speakerCharacterId)) add('WF_REF_UNKNOWN_SPEAKER');
  }

  // --- 页格引用必须存在 ---
  const beatIds = new Set(script.beats.map((b) => b.beatId));
  const dialogueIds = new Set(script.dialogues.map((d) => d.dialogueId));
  for (const page of panelPlan.pages) {
    for (const panel of page.panels) {
      if (!beatIds.has(panel.beatId) || !sceneIds.has(panel.sceneId)) add('WF_REF_DANGLING');
      for (const id of panel.characterIds) if (!characterIds.has(id)) add('WF_REF_DANGLING');
      for (const id of panel.dialogueIds) if (!dialogueIds.has(id)) add('WF_REF_DANGLING');
    }
  }

  // --- 页数与每页格数上限 ---
  if (panelPlan.pages.length > brief.limits.maxPages) add('WF_LIMIT_PAGES');
  if (panelPlan.pages.some((p) => p.panels.length > brief.limits.maxPanelsPerPage)) {
    add('WF_LIMIT_PANELS');
  }

  // --- 阅读顺序必须连续无洞 ---
  const sortedPages = [...panelPlan.pages].sort((a, b) => a.ordinal - b.ordinal);
  sortedPages.forEach((page, index) => {
    if (page.ordinal !== index) add('WF_LAYOUT_READING_ORDER_INVALID');
    const sortedPanels = [...page.panels].sort((a, b) => a.ordinal - b.ordinal);
    sortedPanels.forEach((panel, panelIndex) => {
      if (panel.ordinal !== panelIndex) add('WF_LAYOUT_READING_ORDER_INVALID');
    });
  });

  // --- 资产需求与已批准引用一一对应 ---
  const requiredKeys = new Set(assetManifest.items.map((i) => i.itemKey));
  const approvedKeys = new Set(approvedRefs.map((r) => r.itemKey));
  for (const key of requiredKeys) if (!approvedKeys.has(key)) add('WF_REF_ASSET_NOT_APPROVED');
  for (const ref of approvedRefs) {
    if (!requiredKeys.has(ref.itemKey)) add('WF_REF_ITEM_KEY_INVALID');
    // 同一 itemKey 的多个批准引用意味着版本分歧，视为陈旧。
    if (approvedRefs.filter((r) => r.itemKey === ref.itemKey).length > 1) {
      add('WF_REF_ASSET_VERSION_STALE');
    }
  }

  // --- 渲染规格只允许已批准引用，且数量受限 ---
  const approvedByKey = new Map(approvedRefs.map((r) => [r.itemKey, r]));
  const panelIds = new Set(panelPlan.pages.flatMap((p) => p.panels.map((x) => x.panelId)));
  const specPanelIds = new Set(renderSpecs.map((s) => s.panelId));
  for (const spec of renderSpecs) {
    if (!panelIds.has(spec.panelId)) add('WF_REF_DANGLING');
    if (spec.referenceAssetRefs.length > brief.limits.maxReferencesPerPanel) {
      add('WF_LIMIT_REFERENCES');
    }
    for (const ref of spec.referenceAssetRefs) {
      const approved = approvedByKey.get(ref.itemKey);
      if (!approved) {
        add('WF_REF_ASSET_NOT_APPROVED');
        continue;
      }
      // 引用必须精确到被批准的那一个版本；换了版本就是陈旧引用。
      if (approved.version !== ref.version || approved.contentDigest !== ref.contentDigest) {
        add('WF_REF_ASSET_VERSION_STALE');
      }
    }
    // 提示词长度沿用现有 promptDocument 上限（index.ts:330）。
    if (spec.promptText.length > 20_000) add('WF_LIMIT_PROMPT_CHARS');
  }
  for (const panelId of panelIds) if (!specPanelIds.has(panelId)) add('WF_EXPORT_INCOMPLETE');

  // --- 排版必须覆盖每个格，且不出画布 ---
  const laidOut = new Set<string>();
  for (const layout of layouts) {
    for (const panel of layout.panels) {
      if (!panelIds.has(panel.panelId)) add('WF_REF_DANGLING');
      laidOut.add(panel.panelId);
      const { x, y, width, height } = panel.rect;
      const overflows =
        x + width > layout.canvas.width + 0.5 || y + height > layout.canvas.height + 0.5;
      if (overflows) add('WF_LAYOUT_RECT_INVALID');
    }
    for (const balloon of layout.balloons) {
      if (!panelIds.has(balloon.panelId)) add('WF_REF_DANGLING');
      if (!dialogueIds.has(balloon.dialogueId)) add('WF_REF_DANGLING');
      const inside =
        balloon.anchor.x >= 0 &&
        balloon.anchor.y >= 0 &&
        balloon.anchor.x <= layout.canvas.width &&
        balloon.anchor.y <= layout.canvas.height;
      if (!inside) add('WF_LAYOUT_BALLOON_OVERFLOW');
    }
  }
  for (const panelId of panelIds) if (!laidOut.has(panelId)) add('WF_LAYOUT_PANEL_MISSING');

  // --- 导出清单完整性 ---
  const manifest = input.exportManifest;
  if (manifest) {
    const exportedPages = new Set(manifest.pages.map((p) => p.pageId));
    for (const page of panelPlan.pages) if (!exportedPages.has(page.pageId)) add('WF_EXPORT_INCOMPLETE');
    if (manifest.pages.length !== panelPlan.pages.length) add('WF_EXPORT_INCOMPLETE');
    if (manifest.definitionVersion !== '0.1.0') add('WF_EXPORT_VERSION_MISMATCH');
  }

  return [...codes];
}

// ===========================================================================
// 12. 输入指纹（D3）
// ===========================================================================

/**
 * 进指纹的材料。**顺序即语义**：数组顺序保留，对象键排序。
 *
 * 刻意排除：时间戳、进度、临时 URL、画布节点坐标、供应商 job id。
 * 刻意包含：排版坐标（成品页的排版是内容，不是展示）。
 */
export const inputFingerprintMaterialSchema = z
  .object({
    schemaVersion: z.literal(CONTRACT_SCHEMA_VERSION),
    definitionDigest: sha256HexSchema,
    stepId: stableIdSchema,
    itemKey: z.string().min(1).max(160),
    generationRevision: generationRevisionSchema,
    taskTemplateDigest: sha256HexSchema,
    outputSchemaVersion: z.number().int().min(1),
    normalizedInputs: z.record(z.unknown()),
    upstreamArtifactDigests: z.array(sha256HexSchema),
    frozenModelBinding: z
      .object({ alias: z.string().min(1), parameters: z.record(z.unknown()) })
      .strict(),
    orderedAssetRefs: z.array(approvedAssetRefSchema),
    /** 只有需要冻结提示词正文的步骤才带；否则为 null。 */
    frozenPromptText: z.string().nullable(),
  })
  .strict();

export type InputFingerprintMaterial = z.infer<typeof inputFingerprintMaterialSchema>;

/**
 * 规范 JSON：对象键排序、丢弃 undefined、数组保序。
 * 不做数值规范化（1 与 1.0 视为不同），因为参数精度本身就是输入。
 */
export function canonicalizeForFingerprint(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalizeForFingerprint(entry)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  const body = keys
    .map((key) => `${JSON.stringify(key)}:${canonicalizeForFingerprint(record[key])}`)
    .join(',');
  return `{${body}}`;
}

/** 产出待哈希的规范字符串。哈希算法由调用方注入，见 D3。 */
export function computeInputFingerprintMaterial(material: InputFingerprintMaterial): string {
  const parsed = inputFingerprintMaterialSchema.parse(material);
  return canonicalizeForFingerprint(parsed);
}

/**
 * 计算指纹。hasher 由调用方注入（Node 侧传 sha256 实现，浏览器侧可传 WebCrypto 包装）。
 */
export function inputFingerprint(
  material: InputFingerprintMaterial,
  hash: (canonical: string) => string,
): string {
  return hash(computeInputFingerprintMaterial(material));
}

/**
 * 提交幂等键。受 Run.idempotencyKey 的 200 字符上限约束
 * （packages/domain/src/index.ts:1651），因此只放稳定 ID 与指纹前缀。
 */
export function submitIdempotencyKey(input: {
  definitionId: string;
  stepId: string;
  itemKey: string;
  generationRevision: number;
  fingerprint: string;
}): string {
  const itemKeyHashInput = `${input.definitionId}|${input.stepId}|${input.itemKey}`;
  // 长 itemKey 走摘要折叠；短 itemKey 保持可读，便于线上排查。
  const itemPart =
    itemKeyHashInput.length <= 80
      ? itemKeyHashInput
      : `${input.definitionId}|${input.stepId}|h${simpleHash(itemKeyHashInput)}`;
  const key = `${itemPart}|r${input.generationRevision}|${input.fingerprint.slice(0, 32)}`;
  if (key.length > 200) {
    throw new Error('WF_REPLAY_KEY_TOO_LONG');
  }
  return key;
}

/** 非加密的稳定折叠哈希，仅用于把长 key 压到可读长度。 */
function simpleHash(input: string): string {
  let accumulator = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    accumulator ^= input.charCodeAt(index);
    accumulator = Math.imul(accumulator, 0x01000193) >>> 0;
  }
  return accumulator.toString(16).padStart(8, '0');
}

// ===========================================================================
// 13. 产物 schema 注册表
// ===========================================================================

/**
 * outputSchema 名 -> 该步骤的产物 schema。
 * 键即 workflow-definition.v1.json 的 steps[].outputSchema，两者必须双向命中。
 * 运行时据此校验“Run 成功”之后的“步骤成功”。
 */
export const STEP_OUTPUT_SCHEMAS = {
  comic_brief: comicBriefSchema,
  story_premise: storyPremiseSchema,
  comic_script: comicScriptSchema,
  panel_plan: panelPlanSchema,
  asset_manifest: assetManifestSchema,
  asset_candidate_set: assetCandidateSetSchema,
  panel_render_spec_set: panelRenderSpecSetSchema,
  panel_candidate_set: panelCandidateSetSchema,
  quality_report: qualityReportSchema,
  page_layout: pageLayoutSchema,
  rendered_page_set: renderedPageSetSchema,
  comic_export_manifest: comicExportManifestSchema,
} as const;

export type StepOutputSchemaName = keyof typeof STEP_OUTPUT_SCHEMAS;
