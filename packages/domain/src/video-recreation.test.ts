import { describe, expect, it } from 'vitest';
import {
  buildVideoRecreationPrompt,
  getVideoRecreationIssue,
  parseVideoRecreationTemplate,
  videoRecreationConfigSchema,
  type VideoRecreationConfig,
  type VideoRecreationTemplate,
} from './video-recreation';
import { canvasDocumentSchema, parseReversePromptOutput, renderPromptDocument } from './index';

/** 完整十秒双镜头，人物身份仅由角色键表达。 */
const template: VideoRecreationTemplate = {
  version: 1,
  durationSeconds: 10,
  roles: [{ id: 'character_a', label: '主角' }],
  shots: [
    {
      startSeconds: 0,
      endSeconds: 4,
      action: 'character_a转身、抬手，保持手中商品',
      camera: '中景跟随',
    },
    {
      startSeconds: 4,
      endSeconds: 10,
      action: 'character_a将商品正面朝向镜头并停住',
      camera: '推近至商品特写',
    },
  ],
  unknowns: ['无法读清原包装文字'],
};
/** 可执行配置不含URL或服务端凭据明文，全部绑定冻结版本。 */
const ready: VideoRecreationConfig = {
  version: 1,
  source: { assetId: 'video', assetVersion: 2, name: '舞蹈广告', durationSeconds: 10 },
  analysis: { runId: 'analysis-1', summary: '先转身再展示商品', template },
  bindings: [{ roleId: 'character_a', assetId: 'person', assetVersion: 3, name: '我的人物' }],
};

describe('整条短视频复刻合同', () => {
  it('解析完整时间轴并兼容旧反推返回', () => {
    expect(parseVideoRecreationTemplate(JSON.stringify(template))).toEqual(template);
    expect(parseReversePromptOutput('{"summary":"旧摘要","prompt":"旧提示词"}')).toEqual({
      summary: '旧摘要',
      prompt: '旧提示词',
    });
    expect(
      parseReversePromptOutput(
        JSON.stringify({ summary: '摘要', prompt: JSON.stringify(template) }),
        'video_recreation',
      ).prompt,
    ).toBe(JSON.stringify(template));
    expect(() =>
      parseReversePromptOutput('{"summary":"旧摘要","prompt":"旧提示词"}', 'video_recreation'),
    ).toThrow('反推结果格式无效');
  });
  it.each([
    { ...template, durationSeconds: 9 },
    { ...template, shots: [{ startSeconds: 1, endSeconds: 10, action: '转身', camera: '跟随' }] },
    { ...template, shots: [{ ...template.shots[0]!, endSeconds: 5 }, template.shots[1]!] },
    { ...template, shots: [template.shots[0]!, { ...template.shots[1]!, startSeconds: 5 }] },
    { ...template, roles: [...template.roles, template.roles[0]!] },
    { ...template, roles: [{ id: 'bad role', label: '人物' }] },
    { ...template, durationSeconds: 0 },
    { ...template, shots: [] },
  ])('拒绝缺段、重叠、无效时长或身份：%j', (value) =>
    expect(() => parseVideoRecreationTemplate(JSON.stringify(value))).toThrow('视频模板无效'),
  );
  it('创建时无分析和人物，不能执行生成', () => {
    expect(getVideoRecreationIssue({ version: 1, source: ready.source, bindings: [] })).toBe(
      '请先分析整条参考视频',
    );
    expect(getVideoRecreationIssue({ ...ready, bindings: [] })).toContain('主角');
    expect(getVideoRecreationIssue({ ...ready, request: { idempotencyKey: 'unknown' } })).toContain(
      '原请求',
    );
    expect(
      getVideoRecreationIssue({ ...ready, source: { ...ready.source, durationSeconds: 12 } }),
    ).toContain('时长');
  });
  it('拒绝不属于当前模板的角色、重复绑定和零人物模板', () => {
    expect(
      getVideoRecreationIssue({ ...ready, bindings: [...ready.bindings, ready.bindings[0]!] }),
    ).toContain('重复');
    expect(
      getVideoRecreationIssue({
        ...ready,
        bindings: [{ ...ready.bindings[0]!, roleId: 'stranger' }],
      }),
    ).toContain('不一致');
    expect(
      getVideoRecreationIssue({
        ...ready,
        analysis: { ...ready.analysis!, template: { ...template, roles: [] } },
      }),
    ).toContain('未识别');
  });
  it('换人物只重建提示词，保留原始分析并按冻结身份引用', () => {
    const before = structuredClone(ready);
    const doc = buildVideoRecreationPrompt(ready);
    expect(doc.blocks.filter((block) => block.type === 'mention')).toMatchObject([
      { assetId: 'video', assetVersion: 2, mediaType: 'video' },
      { assetId: 'person', assetVersion: 3, mediaType: 'image' },
    ]);
    expect(renderPromptDocument(doc)).toContain('Full observed duration: 10 seconds');
    expect(renderPromptDocument(doc)).toContain('Preserve existing props/products');
    expect(ready).toEqual(before);
    const changed = buildVideoRecreationPrompt({
      ...ready,
      bindings: [{ ...ready.bindings[0]!, assetId: 'another-person', assetVersion: 7 }],
    });
    expect(changed.blocks.filter((block) => block.type === 'mention')[1]).toMatchObject({
      assetId: 'another-person',
      assetVersion: 7,
    });
  });
  it('多人可复用同一资源但不能重复发出token，角色映射保持可读', () => {
    const duo = {
      ...ready,
      analysis: {
        ...ready.analysis!,
        template: { ...template, roles: [...template.roles, { id: 'character_b', label: '配角' }] },
      },
      bindings: [...ready.bindings, { ...ready.bindings[0]!, roleId: 'character_b' }],
    };
    const doc = buildVideoRecreationPrompt(duo);
    expect(doc.blocks.filter((block) => block.type === 'mention')).toHaveLength(2);
    expect(renderPromptDocument(doc)).toContain('same character image bound to character_a');
  });
  it('商品替换要求用途，组装适配动作约束且不添加未经确认卖点', () => {
    const product = { assetId: 'perfume', assetVersion: 4, name: '我的香水' };
    expect(getVideoRecreationIssue({ ...ready, product })).toContain('用途');
    const doc = buildVideoRecreationPrompt({
      ...ready,
      product,
      productDescription: '香水；喷洒在手腕，不饮用。',
    });
    expect(renderPromptDocument(doc)).toContain('Never drink perfume');
    expect(renderPromptDocument(doc)).toContain('香水；喷洒在手腕，不饮用。');
    expect(doc.blocks.filter((block) => block.type === 'mention')).toHaveLength(3);
  });
  it('配置与画布保存恢复不丢模板、绑定、幂等身份', () => {
    const config = {
      ...ready,
      request: { idempotencyKey: 'pending-key', runId: 'pending-run', modelAlias: 'vision-model' },
    };
    const canvas = canvasDocumentSchema.parse({
      revision: 1,
      nodes: [
        {
          id: 'recreate',
          type: 'video',
          position: { x: 0, y: 0 },
          data: {
            label: '短视频复刻',
            mediaType: 'video',
            mode: 'generate',
            videoRecreation: config,
          },
        },
      ],
      edges: [],
    });
    expect(canvas.nodes[0]!.data.videoRecreation).toEqual(config);
    expect(() =>
      videoRecreationConfigSchema.parse({
        ...ready,
        source: { ...ready.source, assetVersion: undefined },
      }),
    ).toThrow();
  });
});
