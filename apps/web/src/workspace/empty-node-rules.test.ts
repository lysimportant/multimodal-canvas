import { describe, expect, it } from 'vitest';

import {
  classifyEmptyPromptNode,
  collectEmptyNodeCandidates,
  emptyNodeRetentionLabels,
  hasPromptContent,
  hasRetainedResult,
  isActiveRunStatus,
  type EmptyNodeCandidateInput,
  type EmptyNodeRetentionReason,
} from './empty-node-rules';

/** 构造提示词节点，默认是新建后未输入任何内容的空模板。 */
function node(
  id: string,
  data: Partial<EmptyNodeCandidateInput['data']> = {},
): EmptyNodeCandidateInput {
  return {
    id,
    data: { mediaType: 'image', mode: 'generate', ...data },
  };
}

/** 结构化提示词文档，用于覆盖只看旧 prompt 字段会漏判的情况。 */
function promptDocument(blocks: Array<Record<string, unknown>>) {
  return { version: 1, blocks };
}

describe('classifyEmptyPromptNode', () => {
  it('新建节点、未输入文字、未绑定资源、无任务时是候选', () => {
    expect(classifyEmptyPromptNode(node('a'))).toEqual({
      isEmpty: true,
      removable: true,
      candidate: true,
    });
  });

  it('提示词为空或仅空白且没有其他内容时是候选', () => {
    expect(classifyEmptyPromptNode(node('a', { prompt: '' })).isEmpty).toBe(true);
    expect(classifyEmptyPromptNode(node('a', { prompt: '   \n\t ' })).isEmpty).toBe(true);
    expect(
      classifyEmptyPromptNode(
        node('a', { promptDocument: promptDocument([{ type: 'text', text: '  ' }]) }),
      ).isEmpty,
    ).toBe(true);
  });

  it('提示词已填写即使从未生成过也保留', () => {
    expect(classifyEmptyPromptNode(node('a', { prompt: '月白布衫' }))).toEqual({
      isEmpty: false,
      category: 'has-prompt',
    });
  });

  it('promptDocument 含有效文本或资源提及时保留，不能只看旧 prompt 字段', () => {
    expect(
      classifyEmptyPromptNode(
        node('a', { promptDocument: promptDocument([{ type: 'text', text: '一段真实内容' }]) }),
      ),
    ).toEqual({ isEmpty: false, category: 'has-prompt' });
    expect(
      classifyEmptyPromptNode(
        node('a', {
          promptDocument: promptDocument([
            { type: 'mention', mentionId: 'm1', assetId: 'asset-1' },
          ]),
        }),
      ),
    ).toEqual({ isEmpty: false, category: 'has-prompt' });
    expect(hasPromptContent(node('a', { prompt: '  ' }))).toBe(false);
  });

  it('有 assetId 但 URL 缺失或预览失败时保留，不把加载失败当空节点', () => {
    expect(classifyEmptyPromptNode(node('a', { assetId: 'asset-1' }))).toEqual({
      isEmpty: false,
      category: 'has-asset',
    });
    expect(classifyEmptyPromptNode(node('a', { assetId: 'asset-1', contentUrl: '' })).isEmpty).toBe(
      false,
    );
    expect(
      classifyEmptyPromptNode(node('a', { assetId: 'asset-1', contentUrl: 'https://x/y.png' }))
        .isEmpty,
    ).toBe(false);
  });

  it('有当前或历史保留结果或手动输出时保留，包含本次失败但旧结果仍在', () => {
    expect(classifyEmptyPromptNode(node('a', { manualOutput: true }))).toEqual({
      isEmpty: false,
      category: 'has-retained-output',
    });
    expect(classifyEmptyPromptNode(node('a', { manualOutputRunId: 'run-1' })).isEmpty).toBe(false);
    expect(classifyEmptyPromptNode(node('a'), { hasRetainedOutput: true })).toEqual({
      isEmpty: false,
      category: 'has-retained-output',
    });
    expect(hasRetainedResult({ asset: { assetId: 'asset-1' } } as never)).toBe(true);
    expect(hasRetainedResult({} as never)).toBe(false);
    expect(hasRetainedResult(undefined)).toBe(false);
  });

  it('只有参考资源、图生图来源或有效上游输入时保留', () => {
    expect(
      classifyEmptyPromptNode(node('a', { resourceRefs: [{ id: 'r1', assetId: 'asset-1' }] })),
    ).toEqual({ isEmpty: false, category: 'has-resource-input' });
    expect(
      classifyEmptyPromptNode(
        node('a', { imageEditSource: { sourceNodeId: 'n1', assetId: 'a1' } }),
      ),
    ).toEqual({ isEmpty: false, category: 'has-resource-input' });
    expect(classifyEmptyPromptNode(node('a'), { hasUpstreamInput: true })).toEqual({
      isEmpty: false,
      category: 'has-upstream-input',
    });
  });

  it('排队、准备、生成、归档、取消请求中或上传中都保留，避免操作竞态', () => {
    for (const status of [
      'queued',
      'preparing',
      'running',
      'processing',
      'cancel_requested',
    ] as const) {
      expect(isActiveRunStatus(status)).toBe(true);
      expect(classifyEmptyPromptNode(node('a'), { hasActiveRun: true })).toEqual({
        isEmpty: false,
        category: 'has-active-operation',
      });
    }
    for (const status of ['draft', 'succeeded', 'failed', 'cancelled', undefined] as const) {
      expect(isActiveRunStatus(status)).toBe(false);
    }
    expect(classifyEmptyPromptNode(node('a'), { busy: true })).toEqual({
      isEmpty: false,
      category: 'has-active-operation',
    });
  });

  it('历史或运行记录尚未恢复、资源状态待查询时先保留', () => {
    expect(classifyEmptyPromptNode(node('a'), { pendingLookup: true })).toEqual({
      isEmpty: false,
      category: 'lookup-pending',
    });
    // 待查询优先于“看起来是空模板”的判断。
    expect(
      classifyEmptyPromptNode(node('a', { prompt: '' }), { pendingLookup: true }).isEmpty,
    ).toBe(false);
  });

  it('只选了模型、Key 或尺寸参数但没有实际输入时仍是候选', () => {
    expect(
      classifyEmptyPromptNode({
        ...node('a'),
        data: {
          mediaType: 'video',
          mode: 'generate',
        },
        width: 400,
        height: 266,
      }).isEmpty,
    ).toBe(true);
  });

  it('来源节点不是提示词节点，清空空节点保留它', () => {
    expect(classifyEmptyPromptNode(node('a', { mode: 'source' }))).toEqual({
      isEmpty: false,
      category: 'not-a-prompt-node',
    });
  });

  it('每个保留原因都有中文说明，确认框可以解释作用范围', () => {
    const reasons: EmptyNodeRetentionReason[] = [
      'has-prompt',
      'has-asset',
      'has-retained-output',
      'has-resource-input',
      'has-upstream-input',
      'has-active-operation',
      'lookup-pending',
      'not-a-prompt-node',
    ];
    for (const reason of reasons) {
      expect(emptyNodeRetentionLabels[reason]).toBeTruthy();
    }
  });
});

describe('collectEmptyNodeCandidates', () => {
  it('按同一规则给出候选与保留统计', () => {
    const nodes = [
      node('empty'),
      node('with-prompt', { prompt: '保留我' }),
      node('with-asset', { assetId: 'asset-1' }),
      node('running'),
    ];
    const result = collectEmptyNodeCandidates(nodes, (candidate) =>
      candidate.id === 'running' ? { hasActiveRun: true } : {},
    );
    expect(result.candidateIds).toEqual(['empty']);
    expect(result.retained).toEqual([
      { id: 'with-prompt', reason: 'has-prompt' },
      { id: 'with-asset', reason: 'has-asset' },
      { id: 'running', reason: 'has-active-operation' },
    ]);
  });

  it('没有任何候选时不产生可删除项', () => {
    expect(collectEmptyNodeCandidates([node('a', { prompt: '内容' })])).toEqual({
      candidateIds: [],
      retained: [{ id: 'a', reason: 'has-prompt' }],
    });
  });
});
