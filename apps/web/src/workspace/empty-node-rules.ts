import type { CanvasNode, MediaType, RunResult, RunStatus } from '@multimodal-canvas/domain';
import { renderPromptDocument } from '@multimodal-canvas/domain';

/** 清空空节点候选判定的节点输入，只包含判定真正需要的字段。 */
export type EmptyNodeCandidateInput = {
  id: string;
  data: {
    mediaType: MediaType;
    mode?: CanvasNode['data']['mode'];
    /**
     * 兼容字段：旧画布只有 `prompt`，新画布以 `promptDocument` 为唯一执行来源。
     * 因此两者都要检查，避免只看旧字段漏掉结构化文档里的内容。
     */
    prompt?: string;
    promptDocument?: unknown;
    assetId?: string;
    contentUrl?: string;
    /**
     * 与节点一同保存的保留结果，例如手动上传或手动输出。
     * 生成结果只存在于运行记录中，由调用方查询后合并进来。
     */
    manualOutput?: boolean;
    manualOutputRunId?: string;
    resourceRefs?: unknown[];
    imageEditSource?: unknown;
  };
  width?: number;
  height?: number;
};

/** 调用方查询到的运行状态与保留结果，用于补足节点自身看不到的信息。 */
export type EmptyNodeRuntimeState = {
  /** 该节点是否有任何正在进行的操作。 */
  busy?: boolean;
  /** 该节点是否有排队、准备、生成、归档、取消请求中或上传中的操作。 */
  hasActiveRun?: boolean;
  /** 该节点当前展示的结果版本是否仍被保留。 */
  hasRetainedOutput?: boolean;
  /** 资源或运行状态尚未读取完成。 */
  pendingLookup?: boolean;
  /** 该节点是否仍有有效上游输入。 */
  hasUpstreamInput?: boolean;
};

/** 判定结果，附带可展示的原因，便于确认框解释为什么某个节点被保留。 */
export type EmptyNodeVerdict =
  | { isEmpty: true; removable: true; candidate: true }
  | { isEmpty: false; category: EmptyNodeRetentionReason };

/** 节点被保留的稳定原因码。 */
export type EmptyNodeRetentionReason =
  | 'has-prompt'
  | 'has-asset'
  | 'has-retained-output'
  | 'has-resource-input'
  | 'has-upstream-input'
  | 'has-active-operation'
  | 'lookup-pending'
  | 'not-a-prompt-node';

/**
 * 判断节点是否属于“清空空节点”候选。
 *
 * 只有同时满足以下条件才可清理：没有自身资源、没有保留的生成结果、没有提示词
 * 内容、没有有效输入引用，且没有进行中的操作。无法确定资源或运行状态时一律
 * 保留，宁可留下空模板也不误删用户内容。
 *
 * 判定只使用持久化身份与内容，不依赖 `contentUrl` 是否可加载：URL 缺失、过期或
 * 预览失败都不等于空节点，因此不使用 `nodeHasEcho`。
 *
 * @param node 待判定的画布节点。
 * @param runtime 调用方查询到的运行与资源状态；缺省表示没有进行中的操作。
 * @returns 是否可清理，或保留原因。
 */
export function classifyEmptyPromptNode(
  node: EmptyNodeCandidateInput,
  runtime: EmptyNodeRuntimeState = {},
): EmptyNodeVerdict {
  // 只有提示词节点（文字/图片/音频/视频生成节点）参与清空空节点；分组区域
  // 不是媒体节点，保留由分组功能自己处理。
  if (!node.data.mode || node.data.mode === 'source') {
    return { isEmpty: false, category: 'not-a-prompt-node' };
  }
  if (runtime.pendingLookup) return { isEmpty: false, category: 'lookup-pending' };
  if (runtime.busy || runtime.hasActiveRun) {
    return { isEmpty: false, category: 'has-active-operation' };
  }
  if (runtime.hasRetainedOutput || node.data.manualOutput || node.data.manualOutputRunId) {
    return { isEmpty: false, category: 'has-retained-output' };
  }
  if (hasPersistedAsset(node)) return { isEmpty: false, category: 'has-asset' };
  if (hasResourceInput(node)) return { isEmpty: false, category: 'has-resource-input' };
  if (hasPromptContent(node)) return { isEmpty: false, category: 'has-prompt' };
  if (runtime.hasUpstreamInput) return { isEmpty: false, category: 'has-upstream-input' };
  return { isEmpty: true, removable: true, candidate: true };
}

/**
 * 提示词字段是否含有效内容。
 *
 * 仅空白不算内容；结构化文档只要含有效文本块或资源提及就算内容，因此不能
 * 只看旧 `prompt` 字段。
 *
 * @param node 待检查的节点。
 * @returns 存在有效提示词内容时为 true。
 */
export function hasPromptContent(node: EmptyNodeCandidateInput): boolean {
  if (node.data.prompt !== undefined && node.data.prompt.trim().length > 0) return true;
  const document = node.data.promptDocument;
  if (!isPromptDocumentShape(document)) return false;
  for (const block of document.blocks) {
    if (block.type === 'text') {
      if ((block.text ?? '').trim().length > 0) return true;
      continue;
    }
    // 资源提及本身可能带补充说明；提及身份本身就是有效输入。
    if (block.type === 'mention') return true;
  }
  return false;
}

/** 节点是否已有持久化资源身份。 */
function hasPersistedAsset(node: EmptyNodeCandidateInput): boolean {
  return Boolean(node.data.assetId);
}

/** 节点是否已有参考资源、图生图来源等创作输入。 */
function hasResourceInput(node: EmptyNodeCandidateInput): boolean {
  return (
    (node.data.resourceRefs?.length ?? 0) > 0 ||
    (node.data.imageEditSource !== undefined && node.data.imageEditSource !== null)
  );
}

/** 结构化提示词文档的最小结构检查，避免对未知数据抛错。 */
function isPromptDocumentShape(
  value: unknown,
): value is { blocks: Array<{ type: string; text?: string }> } {
  if (!value || typeof value !== 'object') return false;
  const blocks = (value as { blocks?: unknown }).blocks;
  if (!Array.isArray(blocks)) return false;
  return blocks.every((block) => Boolean(block && typeof block === 'object' && 'type' in block));
}

/**
 * 由一次运行状态推导节点的进行中状态。
 *
 * 排队、准备、运行、处理与取消请求中都视为进行中，避免清空与运行竞态。
 *
 * @param status 该节点最近一次运行状态。
 * @returns 是否仍有进行中的操作。
 */
export function isActiveRunStatus(status: RunStatus | undefined): boolean {
  return (
    status === 'queued' ||
    status === 'preparing' ||
    status === 'running' ||
    status === 'processing' ||
    status === 'cancel_requested'
  );
}

/**
 * 判断一次运行结果是否构成“保留的输出”。
 *
 * 只要归档出了资产版本就算保留；生成失败但旧结果仍在的节点也保留，因为
 * 旧结果属于用户内容。
 *
 * @param result 运行结果；缺省表示没有结果。
 * @returns 是否存在保留输出。
 */
export function hasRetainedResult(result: RunResult | undefined): boolean {
  return Boolean(result?.asset?.assetId);
}

/**
 * 计算本次“清空空节点”的候选与实际保留数量。
 *
 * 节点类型参数保留调用方的具体节点类型，回调因此可以直接读取运行状态等
 * 附加字段，而不需要额外断言。
 *
 * @param nodes 当前画布上的提示词节点。
 * @param resolveRuntime 按节点查询运行与资源状态的函数。
 * @returns 候选节点 ID 与保留原因统计。
 */
export function collectEmptyNodeCandidates<T extends EmptyNodeCandidateInput>(
  nodes: readonly T[],
  resolveRuntime: (node: T) => EmptyNodeRuntimeState = () => ({}),
): { candidateIds: string[]; retained: Array<{ id: string; reason: EmptyNodeRetentionReason }> } {
  const candidateIds: string[] = [];
  const retained: Array<{ id: string; reason: EmptyNodeRetentionReason }> = [];
  for (const node of nodes) {
    const verdict = classifyEmptyPromptNode(node, resolveRuntime(node));
    if (verdict.isEmpty) candidateIds.push(node.id);
    else retained.push({ id: node.id, reason: verdict.category });
  }
  return { candidateIds, retained };
}

/** 保留原因的中文说明，用于确认框解释清理范围。 */
export const emptyNodeRetentionLabels: Record<EmptyNodeRetentionReason, string> = {
  'has-prompt': '已填写提示词',
  'has-asset': '已绑定资源',
  'has-retained-output': '已有保留结果',
  'has-resource-input': '已有参考资源或图生图来源',
  'has-upstream-input': '有有效上游输入',
  'has-active-operation': '有进行中的操作',
  'lookup-pending': '资源或运行状态待查询',
  'not-a-prompt-node': '不是提示词节点',
};

/** 渲染提示词文档的纯文本，供确认框预览使用。 */
export function promptPreviewText(node: EmptyNodeCandidateInput): string {
  if (isPromptDocumentShape(node.data.promptDocument)) {
    try {
      return renderPromptDocument(node.data.promptDocument as never);
    } catch {
      return '';
    }
  }
  return node.data.prompt ?? '';
}
