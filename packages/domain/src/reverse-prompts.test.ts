import { describe, expect, it } from 'vitest';
import { parseReversePromptOutput, runJobDataSchema, runSnapshotSchema } from './index';

/** 只包含一个文字分析节点和精确版本提及的合法分析快照。 */
const snapshot = {
  projectId: 'project',
  canvasRevision: 0,
  targetNodeId: 'analysis',
  modelAlias: 'text-model',
  parameters: {},
  submittedAt: '2026-09-17T00:00:00.000Z',
  nodes: [
    {
      id: 'analysis',
      type: 'text',
      position: { x: 0, y: 0 },
      data: { label: '分析', mediaType: 'text', mode: 'generate' },
    },
  ],
  edges: [],
  inputs: [],
  promptMentions: [
    {
      mentionId: 'source',
      assetId: 'source',
      assetVersion: 2,
      mediaType: 'image',
      label: 'Resource',
      blockOrder: 0,
    },
  ],
  reversePrompt: { assetId: 'source', assetVersion: 2, automatic: true },
};

describe('独立反推结果与快照', () => {
  it('解析标准 JSON 或单个代码围栏，保留描述内容并去除无关字段', () => {
    expect(
      parseReversePromptOutput('{"summary":" 摘要 ","prompt":"详细描述","unexpected":"ignored"}'),
    ).toEqual({ summary: '摘要', prompt: '详细描述' });
    expect(
      parseReversePromptOutput('```json\n{"summary":"摘要","prompt":"详细描述"}\n```'),
    ).toEqual({ summary: '摘要', prompt: '详细描述' });
  });

  it.each([
    'plain text',
    '{"summary":"只有摘要"}',
    '{"summary":"", "prompt":"内容"}',
    JSON.stringify({ summary: '摘要', prompt: 'x'.repeat(20_001) }),
  ])('拒绝无效结果且错误不回显 Provider 内容', (text) => {
    expect(() => parseReversePromptOutput(text)).toThrow('反推结果格式无效');
  });

  it('反推身份必须匹配单个冻结资源的精确版本', () => {
    expect(runSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(
      runSnapshotSchema.safeParse({
        ...snapshot,
        reversePrompt: { ...snapshot.reversePrompt, assetVersion: 1 },
      }).success,
    ).toBe(false);
    expect(runSnapshotSchema.safeParse({ ...snapshot, promptMentions: [] }).success).toBe(false);
  });

  it('通用运行重试不能重新发起反推任务，正常任务仍然兼容', () => {
    const job = { runId: 'run', snapshot, attempt: 1, provider: 'newapi', cancelRequested: false };
    expect(runJobDataSchema.safeParse(job).success).toBe(true);
    expect(runJobDataSchema.safeParse({ ...job, attempt: 2, retryOf: 'prior' }).success).toBe(
      false,
    );
  });
});
