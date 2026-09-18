import { describe, expect, it } from 'vitest';
import {
  createPromptOptimizationCanvas,
  createMockPromptOptimizationOutput,
  parsePromptOptimizationOutput,
  PROMPT_SKILLS,
  canvasDocumentSchema,
  runSnapshotSchema,
  type PromptDocument,
} from './index.js';

/** 合成引用包含版本和绑定元数据，用于验证优化不能改变资源身份。 */
const input: PromptDocument = {
  version: 1,
  blocks: [
    { type: 'text', text: '让 ' },
    {
      type: 'mention',
      mentionId: 'ref-one',
      assetId: 'asset-one',
      assetVersion: 3,
      label: '角色甲',
      mediaType: 'image',
      semanticRole: 'character',
    },
    { type: 'text', text: ' 站在 ' },
    {
      type: 'mention',
      mentionId: 'ref-two',
      assetId: 'asset-two',
      label: '庭院',
      mediaType: 'image',
    },
  ],
};

describe('提示词 Skill 契约', () => {
  it('模拟输出仅回传原文，并通过真实资源校验协议', () => {
    const result = parsePromptOptimizationOutput(createMockPromptOptimizationOutput(input), input);
    expect(result.promptDocument).toEqual(input);
  });
  it('每个技能可为所有媒体构造独立文字任务，输入引用不被发送', () => {
    for (const skill of PROMPT_SKILLS) {
      for (const mediaType of ['text', 'image', 'audio', 'video'] as const) {
        const canvas = createPromptOptimizationCanvas({ skillId: skill.id, input, mediaType });
        expect(canvasDocumentSchema.safeParse(canvas).success).toBe(true);
        expect(
          canvas.nodes[0]!.data.promptDocument!.blocks.every((block) => block.type === 'text'),
        ).toBe(true);
        expect(JSON.stringify(canvas)).not.toContain('asset-one');
        expect(JSON.stringify(canvas)).toContain('[[SKILL_REF_1]]');
      }
    }
  });

  it('保留原始文字语言以及资源版本和语义身份', () => {
    const result = parsePromptOptimizationOutput(
      JSON.stringify({ prompt: '保持构图：[[SKILL_REF_1]] 在 [[SKILL_REF_2]]，柔和侧光。' }),
      input,
    );
    expect(result.promptDocument.blocks.filter((block) => block.type === 'mention')).toEqual(
      input.blocks.filter((block) => block.type === 'mention'),
    );
    expect(input.blocks[0]).toEqual({ type: 'text', text: '让 ' });
  });

  it.each([
    '只保留 [[SKILL_REF_1]]',
    '[[SKILL_REF_2]] [[SKILL_REF_1]]',
    '[[SKILL_REF_1]] [[SKILL_REF_1]] [[SKILL_REF_2]]',
    '[[SKILL_REF_1]] [[SKILL_REF_2]] [[SKILL_REF_3]]',
    '[[SKILL_REF_1]] [[SKILL_REF_2]] [[SKILL_REF_3]',
  ])('拒绝缺失、重复、重排或新增资源标记：%s', (prompt) => {
    expect(() => parsePromptOptimizationOutput(JSON.stringify({ prompt }), input)).toThrow('Skill');
  });

  it('原文包含相似标记时仍能恢复真实引用', () => {
    const source: PromptDocument = {
      version: 1,
      blocks: [{ type: 'text', text: '字面量 [[SKILL_REF_1]] ' }, input.blocks[1]!],
    };
    const result = parsePromptOptimizationOutput(
      JSON.stringify({ prompt: '字面量 [[SKILL_REF_1]]，引用 [[_SKILL_REF_1]]' }),
      source,
    );
    expect(result.promptDocument.blocks[0]).toEqual({
      type: 'text',
      text: '字面量 [[SKILL_REF_1]]，引用 ',
    });
    expect(result.promptDocument.blocks[1]).toEqual(input.blocks[1]);
  });

  it.each(['[[SKILL_REF_1]][[SKILL_REF_2]]', ' \n[[SKILL_REF_1]] \n[[SKILL_REF_2]]\t'])(
    '资源标记不算优化正文：%s',
    (prompt) => {
      expect(() => parsePromptOptimizationOutput(JSON.stringify({ prompt }), input)).toThrow(
        '缺少提示词文字',
      );
    },
  );

  it('拒绝未知技能、空输入、超长输入和无效模型输出', () => {
    expect(() =>
      createPromptOptimizationCanvas({ skillId: 'missing', input, mediaType: 'image' }),
    ).toThrow('不可用');
    for (const text of ['', 'x'.repeat(20_000)])
      expect(() =>
        createPromptOptimizationCanvas({
          skillId: 'scene',
          input: { version: 1, blocks: [{ type: 'text', text }] },
          mediaType: 'image',
        }),
      ).toThrow();
    for (const text of [
      'invalid',
      '{}',
      '{"prompt":" "}',
      JSON.stringify({ prompt: 'x'.repeat(20_001) }),
    ])
      expect(() => parsePromptOptimizationOutput(text, input)).toThrow();
  });

  it('旧画布保持兼容，新选择经过序列化后保留', () => {
    const canvas = createPromptOptimizationCanvas({ skillId: 'scene', input, mediaType: 'image' });
    expect(canvasDocumentSchema.parse(canvas).nodes[0]!.data.promptSkillId).toBeUndefined();
    canvas.nodes[0]!.data.promptSkillId = 'scene';
    expect(
      canvasDocumentSchema.parse(JSON.parse(JSON.stringify(canvas))).nodes[0]!.data.promptSkillId,
    ).toBe('scene');
  });

  it('冻结优化任务并拒绝与反推、媒体提及混用', () => {
    const canvas = createPromptOptimizationCanvas({ skillId: 'scene', input, mediaType: 'image' });
    const snapshot = {
      projectId: 'project',
      canvasRevision: 0,
      targetNodeId: canvas.nodes[0]!.id,
      modelAlias: 'text-model',
      parameters: {},
      submittedAt: new Date().toISOString(),
      nodes: canvas.nodes,
      edges: [],
      inputs: [],
      promptOptimization: {
        nodeId: 'original-node',
        skillId: 'scene',
        skillVersion: '1.0.0',
        input,
      },
    };
    expect(runSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(
      runSnapshotSchema.safeParse({
        ...snapshot,
        reversePrompt: { assetId: 'asset-one', assetVersion: 1, automatic: false },
      }).success,
    ).toBe(false);
    snapshot.nodes[0]!.data.promptDocument!.blocks.push(input.blocks[1]!);
    expect(runSnapshotSchema.safeParse(snapshot).success).toBe(false);
  });
});
