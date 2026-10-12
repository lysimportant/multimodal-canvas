import { describe, expect, it } from 'vitest';
import {
  buildVideoRecreationPrompt,
  getVideoRecreationIssue,
  parseVideoRecreationTemplate,
  videoRecreationConfigSchema,
  VIDEO_RECREATION_ANALYSIS_INSTRUCTION,
  type VideoRecreationConfig,
  type VideoRecreationTemplate,
} from './video-recreation';
import {
  canvasDocumentSchema,
  canvasNodeSchema,
  nodeDataSchema,
  parseReversePromptOutput,
  renderPromptDocument,
  runJobDataSchema,
  runSnapshotSchema,
  type CanvasNode,
  type RunSnapshot,
} from './index';

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
/** 新分析保留来源对象的外观、出现时间和截图定位；人物与商品键彼此独立。 */
const objectTemplate: VideoRecreationTemplate = {
  ...template,
  roles: [
    {
      id: 'character_a',
      label: '主角',
      description: '短发，浅色上衣，站在左侧',
      appearances: [{ startSeconds: 0, endSeconds: 10 }],
      preview: { timestampSeconds: 1, boundingBox: { x: 0.1, y: 0.1, width: 0.3, height: 0.8 } },
    },
    { id: 'character_b', label: '配角', description: '长发，站在右侧' },
  ],
  products: [
    {
      id: 'product_a',
      label: '方形瓶装商品',
      description: '透明瓶身、白色瓶盖；包装文字无法辨认',
      appearances: [
        { startSeconds: 0, endSeconds: 4 },
        { startSeconds: 6, endSeconds: 10 },
      ],
      preview: { timestampSeconds: 7, boundingBox: { x: 0.4, y: 0.4, width: 0.2, height: 0.3 } },
    },
    { id: 'product_b', label: '圆形罐装商品' },
    { id: 'product_c', label: '纸盒商品' },
  ],
};
/** 一人替换、一人保留，商品逐项绑定；未绑定商品按来源保留。 */
const objectReady: VideoRecreationConfig = {
  ...ready,
  analysis: {
    ...ready.analysis!,
    modelAlias: 'vision-analysis-model',
    credentialId: 'analysis-credential',
    template: objectTemplate,
  },
  preservedRoleIds: ['character_b'],
  productBindings: [
    {
      productId: 'product_a',
      assetId: 'perfume',
      assetVersion: 4,
      name: '我的香水',
      description: '香水；喷洒在手腕，不饮用。',
    },
  ],
};

/** 尚未选择来源的空复刻节点，仅持久化专属入口标记。 */
const draftNode: CanvasNode = {
  id: 'recreation-draft',
  type: 'video',
  position: { x: 0, y: 0 },
  data: { label: '短视频复刻', mediaType: 'video', mode: 'generate', videoRecreationDraft: true },
};
/** 独立普通视频目标，用于验证未执行草稿不会阻止其他节点生成。 */
const ordinaryNode: CanvasNode = {
  ...draftNode,
  id: 'ordinary-video',
  data: { label: '普通视频', mediaType: 'video', mode: 'generate' },
};
/** 尝试直接执行空草稿的快照，必须在进入队列前被拒绝。 */
const draftSnapshot: RunSnapshot = {
  projectId: 'project',
  canvasRevision: 1,
  targetNodeId: draftNode.id,
  modelAlias: 'video-model',
  parameters: {},
  submittedAt: '2026-10-12T00:00:00.000Z',
  nodes: [draftNode],
  edges: [],
  inputs: [],
};

describe('短视频复刻空草稿', () => {
  it('保存与 JSON 恢复保留空草稿，不插入来源、分析或默认参数', () => {
    const canvas = { revision: 1, nodes: [draftNode], edges: [] };
    expect(canvasDocumentSchema.parse(JSON.parse(JSON.stringify(canvas)))).toEqual(canvas);
    expect(nodeDataSchema.parse(draftNode.data)).toEqual(draftNode.data);
    expect(nodeDataSchema.shape.videoRecreationDraft.parse(true)).toBe(true);
  });

  it('普通节点与旧冻结配置不补草稿标记，已冻结来源配置保持兼容', () => {
    const frozenNode = {
      ...ordinaryNode,
      id: 'frozen-recreation',
      data: { ...ordinaryNode.data, videoRecreation: ready },
    };
    const canvas = { revision: 1, nodes: [draftNode, ordinaryNode, frozenNode], edges: [] };
    const restored = canvasDocumentSchema.parse(JSON.parse(JSON.stringify(canvas)));
    expect(restored).toEqual(canvas);
    expect(restored.nodes[1]!.data).not.toHaveProperty('videoRecreationDraft');
    expect(restored.nodes[2]!.data).not.toHaveProperty('videoRecreationDraft');
  });

  it.each([false, 1, 'true', {}, null])('拒绝无效草稿标记：%j', (videoRecreationDraft) => {
    expect(
      canvasNodeSchema.safeParse({
        ...draftNode,
        data: { ...draftNode.data, videoRecreationDraft },
      }).success,
    ).toBe(false);
  });

  it.each([
    { ...draftNode, type: 'image' },
    { ...draftNode, data: { ...draftNode.data, mediaType: 'image' } },
    { ...draftNode, data: { ...draftNode.data, mode: 'source' } },
    { ...draftNode, data: { ...draftNode.data, videoRecreation: ready } },
  ])('空草稿只适用于未冻结来源的视频生成节点：%j', (node) => {
    expect(canvasNodeSchema.safeParse(node).success).toBe(false);
  });

  it('明确选择来源后移除草稿标记，保存完整 v1 配置', () => {
    const { videoRecreationDraft: _draft, ...data } = draftNode.data;
    const configured = { ...draftNode, data: { ...data, videoRecreation: ready } };
    expect(canvasNodeSchema.parse(configured)).toEqual(configured);
    expect(canvasNodeSchema.parse(configured).data).not.toHaveProperty('videoRecreationDraft');
  });

  it('空来源不满足分析或生成配置，不放宽已有来源版本要求', () => {
    const missingSource = { ...ready, source: undefined } as unknown as VideoRecreationConfig;
    expect(videoRecreationConfigSchema.safeParse(draftNode.data).success).toBe(false);
    expect(videoRecreationConfigSchema.safeParse(missingSource).success).toBe(false);
    expect(getVideoRecreationIssue(missingSource)).toContain('配置无效');
    expect(() => buildVideoRecreationPrompt(missingSource)).toThrow('配置无效');
  });

  it('执行目标仍为空草稿时拒绝运行快照和队列合同', () => {
    const result = runSnapshotSchema.safeParse(draftSnapshot);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ['nodes', 0, 'data', 'videoRecreationDraft'],
          message: '请先选择或上传完整参考视频，再分析或生成复刻视频',
        }),
      );
    }
    expect(
      runJobDataSchema.safeParse({
        runId: 'draft-run',
        snapshot: draftSnapshot,
        attempt: 1,
        provider: 'newapi',
        cancelRequested: false,
      }).success,
    ).toBe(false);
  });

  it('未执行的独立草稿不阻止其他视频目标的快照', () => {
    const snapshot = {
      ...draftSnapshot,
      targetNodeId: ordinaryNode.id,
      nodes: [draftNode, ordinaryNode],
    };
    expect(runSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it('启用上游空草稿不能进入生成，禁用上游草稿不阻止目标', () => {
    const snapshot = {
      ...draftSnapshot,
      targetNodeId: ordinaryNode.id,
      nodes: [draftNode, ordinaryNode],
      edges: [
        {
          id: 'draft-reference',
          sourceNodeId: draftNode.id,
          sourceHandle: 'output:video',
          targetNodeId: ordinaryNode.id,
          targetHandle: 'input:content',
          order: 0,
        },
      ],
    };
    expect(runSnapshotSchema.safeParse(snapshot).success).toBe(false);
    expect(
      runSnapshotSchema.safeParse({
        ...snapshot,
        nodes: [{ ...draftNode, data: { ...draftNode.data, enabled: false } }, ordinaryNode],
      }).success,
    ).toBe(true);
  });
});

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
  it('旧v1模板和配置不会插入对象卡、保留或商品绑定默认值', () => {
    expect(parseVideoRecreationTemplate(JSON.stringify(template))).toEqual(template);
    expect(videoRecreationConfigSchema.parse(ready)).toEqual(ready);
    expect(parseVideoRecreationTemplate(JSON.stringify(objectTemplate))).toEqual(objectTemplate);
  });
  it('分析指令识别整片人物与广告商品，中文外观只用于对象识别', () => {
    expect(VIDEO_RECREATION_ANALYSIS_INSTRUCTION).toContain('ENTIRE attached short video');
    expect(VIDEO_RECREATION_ANALYSIS_INSTRUCTION).toContain('"products"');
    expect(VIDEO_RECREATION_ANALYSIS_INSTRUCTION).toContain('Chinese visible appearance');
    expect(VIDEO_RECREATION_ANALYSIS_INSTRUCTION).toContain('never as replacement identity');
    expect(VIDEO_RECREATION_ANALYSIS_INSTRUCTION).toContain('normalized 0..1');
    expect(VIDEO_RECREATION_ANALYSIS_INSTRUCTION).toContain(
      'strictly earlier than durationSeconds',
    );
    expect(VIDEO_RECREATION_ANALYSIS_INSTRUCTION).toContain('without guessing brands');
    expect(VIDEO_RECREATION_ANALYSIS_INSTRUCTION).toContain('fail explicitly');
    expect(VIDEO_RECREATION_ANALYSIS_INSTRUCTION).toContain('"dialogue"');
    expect(VIDEO_RECREATION_ANALYSIS_INSTRUCTION).toContain(
      'Transcribe every intelligible spoken line verbatim',
    );
    expect(VIDEO_RECREATION_ANALYSIS_INSTRUCTION).toContain('Use an empty dialogue array');
  });
  it('逐句台词保留原话、说话人和秒数，随分析模板进入生成提示词', () => {
    const withDialogue: VideoRecreationTemplate = {
      ...template,
      dialogue: [
        { startSeconds: 1.2, endSeconds: 2.8, speakerId: 'character_a', text: '这款怎么用？' },
        { startSeconds: 4.5, endSeconds: 5.4, text: '请看这里。' },
      ],
    };
    expect(parseVideoRecreationTemplate(JSON.stringify(withDialogue))).toEqual(withDialogue);
    const prompt = renderPromptDocument(
      buildVideoRecreationPrompt({
        ...ready,
        analysis: { ...ready.analysis!, template: withDialogue },
      }),
    );
    expect(prompt).toContain(
      '"startSeconds":1.2,"endSeconds":2.8,"speakerId":"character_a","text":"这款怎么用？"',
    );
    expect(prompt).toContain('"startSeconds":4.5,"endSeconds":5.4,"text":"请看这里。"');
    expect(prompt).toContain('preserve their text and timing unless the user changes them');
    expect(prompt).not.toContain('do not clone the original speaker or copy original dialogue');
  });
  it.each([
    { dialogue: [{ startSeconds: 1, endSeconds: 11, text: '超出时长' }] },
    { dialogue: [{ startSeconds: 2, endSeconds: 2, text: '没有时长' }] },
    {
      dialogue: [
        { startSeconds: 3, endSeconds: 4, text: '后一句' },
        { startSeconds: 1, endSeconds: 2, text: '前一句' },
      ],
    },
    { dialogue: [{ startSeconds: 1, endSeconds: 2, speakerId: 'product_a', text: '错误说话人' }] },
    { dialogue: [{ startSeconds: 1, endSeconds: 2, text: '' }] },
  ])('拒绝越界、倒序、无效说话人或空台词：%j', ({ dialogue }) => {
    expect(() => parseVideoRecreationTemplate(JSON.stringify({ ...template, dialogue }))).toThrow(
      '视频模板无效',
    );
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
  it.each([
    {
      products: [
        { id: 'product_a', label: '商品甲' },
        { id: 'product_a', label: '商品乙' },
      ],
    },
    { products: [{ id: 'character_a', label: '与人物冲突' }] },
    { products: [{ id: 'bad product', label: '商品' }] },
    { roles: [{ id: 'character_a', label: '人物', appearances: [] }] },
    {
      roles: [
        { id: 'character_a', label: '人物', appearances: [{ startSeconds: -1, endSeconds: 2 }] },
      ],
    },
    {
      roles: [
        { id: 'character_a', label: '人物', appearances: [{ startSeconds: 3, endSeconds: 3 }] },
      ],
    },
    {
      products: [
        { id: 'product_a', label: '商品', appearances: [{ startSeconds: 0, endSeconds: 11 }] },
      ],
    },
    {
      products: [
        {
          id: 'product_a',
          label: '商品',
          appearances: [
            { startSeconds: 4, endSeconds: 6 },
            { startSeconds: 1, endSeconds: 2 },
          ],
        },
      ],
    },
    {
      products: [
        {
          id: 'product_a',
          label: '商品',
          appearances: [
            { startSeconds: 0, endSeconds: 6 },
            { startSeconds: 5, endSeconds: 10 },
          ],
        },
      ],
    },
    { roles: [{ id: 'character_a', label: '人物', preview: { timestampSeconds: 11 } }] },
    {
      products: [
        {
          id: 'product_a',
          label: '商品',
          appearances: [{ startSeconds: 4, endSeconds: 10 }],
          preview: { timestampSeconds: 3 },
        },
      ],
    },
    {
      roles: [
        {
          id: 'character_a',
          label: '人物',
          preview: {
            timestampSeconds: 1,
            boundingBox: { x: 0.8, y: 0, width: 0.3, height: 1 },
          },
        },
      ],
    },
    {
      products: [
        {
          id: 'product_a',
          label: '商品',
          preview: {
            timestampSeconds: 1,
            boundingBox: { x: 0, y: 0.8, width: 1, height: 0.3 },
          },
        },
      ],
    },
    {
      products: [
        {
          id: 'product_a',
          label: '商品',
          preview: {
            timestampSeconds: 1,
            boundingBox: { x: -0.1, y: 0, width: 0.3, height: 0.3 },
          },
        },
      ],
    },
    {
      products: [
        {
          id: 'product_a',
          label: '商品',
          preview: {
            timestampSeconds: 1,
            boundingBox: { x: 0, y: 0, width: 0, height: 0.3 },
          },
        },
      ],
    },
  ])('拒绝对象键冲突、越界或不可信的出现/预览时间：%j', (fields) => {
    expect(() => parseVideoRecreationTemplate(JSON.stringify({ ...template, ...fields }))).toThrow(
      '视频模板无效',
    );
  });
  it.each(['roles', 'products'] as const)(
    '%s的预览不能位于整片终点，出现区间可以覆盖到终点',
    (kind) => {
      const object = {
        id: kind === 'roles' ? 'character_a' : 'product_a',
        label: '可见对象',
        appearances: [{ startSeconds: 0, endSeconds: template.durationSeconds }],
        preview: { timestampSeconds: template.durationSeconds },
      };
      expect(() =>
        parseVideoRecreationTemplate(JSON.stringify({ ...template, [kind]: [object] })),
      ).toThrow('视频模板无效');
      const beforeEnd = {
        ...template,
        [kind]: [{ ...object, preview: { timestampSeconds: template.durationSeconds - 0.001 } }],
      };
      expect(parseVideoRecreationTemplate(JSON.stringify(beforeEnd))).toEqual(beforeEnd);
    },
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
  it('人物明确保留可不上传，但拒绝重复、未知及保留替换冲突', () => {
    expect(getVideoRecreationIssue(objectReady)).toBeUndefined();
    expect(
      getVideoRecreationIssue({ ...objectReady, preservedRoleIds: ['character_b', 'character_b'] }),
    ).toContain('重复保留');
    expect(getVideoRecreationIssue({ ...objectReady, preservedRoleIds: ['stranger'] })).toContain(
      '不一致',
    );
    expect(
      getVideoRecreationIssue({ ...objectReady, preservedRoleIds: ['character_a', 'character_b'] }),
    ).toContain('同时保留和替换');
    expect(
      getVideoRecreationIssue({
        ...objectReady,
        bindings: [],
        preservedRoleIds: ['character_a', 'character_b'],
      }),
    ).toBeUndefined();
    expect(getVideoRecreationIssue({ ...objectReady, preservedRoleIds: undefined })).toContain(
      '配角',
    );
  });
  it('只替换明确绑定的人物和商品，保留人物原貌及未选商品', () => {
    const before = structuredClone(objectReady);
    const doc = buildVideoRecreationPrompt(objectReady);
    const text = renderPromptDocument(doc);
    expect(doc.blocks.filter((block) => block.type === 'mention')).toMatchObject([
      { mentionId: 'recreation_source', assetId: 'video', assetVersion: 2 },
      { mentionId: 'recreation_character_a', assetId: 'person', assetVersion: 3 },
      { mentionId: 'recreation_product_a', assetId: 'perfume', assetVersion: 4 },
    ]);
    expect(text).toContain('Replace only characters and products explicitly bound');
    expect(text).toContain('Character character_b: Preserve this source character unchanged');
    expect(text).toContain('Product product_b: Preserve this source product');
    expect(text).toContain('Product product_c: Preserve this source product');
    expect(text).toContain('User-confirmed facts for product product_a');
    expect(text).toContain('do not apply original faces or clothing to replacement identities');
    expect(objectReady).toEqual(before);
  });
  it('没有人物而识别到商品时可仅替换商品，未绑定商品继续保留', () => {
    const productOnly: VideoRecreationConfig = {
      ...objectReady,
      analysis: { ...objectReady.analysis!, template: { ...objectTemplate, roles: [] } },
      bindings: [],
      preservedRoleIds: [],
    };
    expect(getVideoRecreationIssue(productOnly)).toBeUndefined();
    expect(
      buildVideoRecreationPrompt(productOnly).blocks.filter((b) => b.type === 'mention'),
    ).toHaveLength(2);
    const allPreserved = { ...productOnly, productBindings: [] };
    expect(getVideoRecreationIssue(allPreserved)).toBeUndefined();
    expect(
      buildVideoRecreationPrompt(allPreserved).blocks.filter((b) => b.type === 'mention'),
    ).toHaveLength(1);
  });
  it('商品绑定须属于当前对象且不可重复、共用人物资源或缺少用途', () => {
    const binding = objectReady.productBindings![0]!;
    expect(
      getVideoRecreationIssue({ ...objectReady, productBindings: [binding, binding] }),
    ).toContain('重复绑定');
    expect(
      getVideoRecreationIssue({
        ...objectReady,
        productBindings: [{ ...binding, productId: 'stranger' }],
      }),
    ).toContain('不一致');
    expect(
      getVideoRecreationIssue({
        ...objectReady,
        productBindings: [{ ...binding, assetId: 'person', assetVersion: 99 }],
      }),
    ).toContain('同一资源');
    expect(
      getVideoRecreationIssue({
        ...objectReady,
        productBindings: [{ ...binding, description: undefined }],
      }),
    ).toContain('用途');
    expect(
      getVideoRecreationIssue({
        ...objectReady,
        productBindings: [{ ...binding, description: '  ' }],
      }),
    ).toContain('用途');
    expect(
      getVideoRecreationIssue({
        ...objectReady,
        productBindings: [{ ...binding, assetVersion: 0 }],
      }),
    ).toContain('资源版本');
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
  it('多人与多商品按模板顺序引用，同类共享资源去重且不合并不同版本', () => {
    const binding = objectReady.productBindings![0]!;
    const config = {
      ...objectReady,
      preservedRoleIds: [],
      bindings: [{ ...ready.bindings[0]!, roleId: 'character_b' }, ...ready.bindings],
      productBindings: [
        { ...binding, productId: 'product_c', assetVersion: 5 },
        { ...binding, productId: 'product_b' },
        binding,
      ],
    };
    const doc = buildVideoRecreationPrompt(config);
    expect(doc.blocks.filter((block) => block.type === 'mention')).toMatchObject([
      { mentionId: 'recreation_source', assetId: 'video', assetVersion: 2 },
      { mentionId: 'recreation_character_a', assetId: 'person', assetVersion: 3 },
      { mentionId: 'recreation_product_a', assetId: 'perfume', assetVersion: 4 },
      { mentionId: 'recreation_product_c', assetId: 'perfume', assetVersion: 5 },
    ]);
    expect(renderPromptDocument(doc)).toContain(
      'Character character_b: Use the same character image bound to character_a',
    );
    expect(renderPromptDocument(doc)).toContain(
      'Product product_b replacement appearance reference: Use the same product image bound to product_a',
    );
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
  it('旧单商品与新对象卡并存时明确要求重新映射，不静默丢弃已保存绑定', () => {
    const legacy = {
      product: { assetId: 'old-product', assetVersion: 1, name: '旧商品' },
      productDescription: '洗手液，用于清洁双手。',
    };
    const conflict = { ...objectReady, ...legacy };
    expect(videoRecreationConfigSchema.parse(conflict)).toEqual(conflict);
    expect(getVideoRecreationIssue(conflict)).toContain('旧商品替换');
    expect(() => buildVideoRecreationPrompt(conflict)).toThrow('逐项重新选择');
    expect(
      buildVideoRecreationPrompt({ ...ready, ...legacy }).blocks.filter(
        (b) => b.type === 'mention',
      ),
    ).toMatchObject([
      { assetId: 'video' },
      { assetId: 'person' },
      { mentionId: 'recreation_product', assetId: 'old-product', assetVersion: 1 },
    ]);
  });
  it('配置与画布保存恢复不丢模板、绑定、幂等身份', () => {
    const config = {
      ...objectReady,
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
    expect(() =>
      videoRecreationConfigSchema.parse({
        ...objectReady,
        productBindings: [{ ...objectReady.productBindings![0]!, assetVersion: undefined }],
      }),
    ).toThrow();
  });
});
