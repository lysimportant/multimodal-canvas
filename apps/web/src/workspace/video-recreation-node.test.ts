import { describe, expect, it } from 'vitest';
import { canvasDocumentSchema, type VideoRecreationConfig } from '@multimodal-canvas/domain';
import { applyVideoRecreationConfig, recreationGenerationIssue } from './video-recreation-node';
import { fromCanvasDocument, toCanvasDocument, type FlowNodeData } from '../canvas-utils';

/** 无用户外观硬编码的可保存复刻配置。 */
const config: VideoRecreationConfig = {
  version: 1,
  source: { assetId: 'clip', assetVersion: 4, name: '参考视频' },
  analysis: {
    runId: 'r1',
    summary: '全片动作',
    template: {
      version: 1,
      durationSeconds: 8,
      roles: [{ id: 'actor', label: '主角' }],
      shots: [{ startSeconds: 0, endSeconds: 8, action: 'actor转身抬手', camera: '中景跟随' }],
      unknowns: [],
    },
  },
  bindings: [{ roleId: 'actor', assetId: 'face', assetVersion: 2, name: '人物' }],
};
/** 模拟已有用户参数，验证默认值和分析保存不覆盖显式选择。 */
const data: FlowNodeData = {
  label: '复刻',
  mediaType: 'video',
  mode: 'generate',
  parameters: { duration: 5, resolution: '720p' },
  prompt: '旧人物描述',
};

describe('复刻节点集成数据', () => {
  it('空草稿即使有手写提示词也不能生成', () => {
    expect(recreationGenerationIssue({ ...data, videoRecreationDraft: true })).toContain(
      '选择参考视频',
    );
  });
  it('一次更新配置、引用、中文分镜提示词和全片时长', () => {
    const next = applyVideoRecreationConfig(
      { ...data, parameters: { resolution: '720p' } },
      config,
    );
    expect(next.parameters).toEqual({ duration: 8, resolution: '720p' });
    expect(next.videoMode).toBe('omni_reference');
    expect(next.resourceRefs?.map((ref) => ref.assetId)).toEqual(['face']);
    expect(next.prompt).not.toContain('clip');
    expect(next.prompt).not.toContain('旧人物描述');
    expect(next.prompt).toContain('【镜头编号】：Shot 01');
    expect(recreationGenerationIssue(next)).toBeUndefined();
    expect(data.parameters?.duration).toBe(5);
  });
  it('重新分析和移除人物显示最新分析草稿，但未完成绑定不能生成', () => {
    const next = applyVideoRecreationConfig(data, { ...config, bindings: [] });
    expect(next.prompt).toContain('主角转身抬手');
    expect(next.prompt).toContain('主角：待选择保留或替换图');
    expect(next.prompt).not.toContain('旧人物描述');
    expect(next.resourceRefs).toEqual([]);
    expect(recreationGenerationIssue(next)).toContain('主角');
    const pending = applyVideoRecreationConfig(data, {
      ...config,
      request: { idempotencyKey: 'same-key' },
    });
    expect(recreationGenerationIssue(pending)).toContain('原请求');
  });
  it('生成入口保留参考模式校验，允许用户显式设置不同秒数', () => {
    const next = applyVideoRecreationConfig(data, config);
    expect(recreationGenerationIssue({ ...next, videoMode: 'text_to_video' })).toContain(
      '全能参考',
    );
    expect(recreationGenerationIssue({ ...next, parameters: { duration: 5 } })).toBeUndefined();
    expect(recreationGenerationIssue({ ...next, parameters: { duration: 42.25 } })).toBeUndefined();
    expect(recreationGenerationIssue(data)).toBeUndefined();
  });
  it('后续人物绑定和重新分析不覆盖用户参数，包括显式清空的秒数', () => {
    const next = applyVideoRecreationConfig(data, config);
    const changed = applyVideoRecreationConfig(
      { ...next, parameters: { seconds: 42.25, resolution: 'future-8k', ratio: '13:24' } },
      { ...config, bindings: [] },
    );
    expect(changed.parameters).toEqual({
      seconds: 42.25,
      resolution: 'future-8k',
      ratio: '13:24',
    });
    const cleared = applyVideoRecreationConfig({ ...next, parameters: {} }, config);
    expect(cleared.parameters).toEqual({});
  });
  it('首次分析和更换来源保留用户秒数及别名，只有缺省时才补完整秒数', () => {
    const next = applyVideoRecreationConfig(
      {
        ...data,
        videoRecreation: { ...config, analysis: undefined },
        parameters: { seconds: 7, custom: true },
      },
      config,
    );
    expect(next.parameters).toEqual({ seconds: 7, custom: true });
    const changedSource = applyVideoRecreationConfig(
      { ...next, parameters: { duration: 42.25, custom: true } },
      { ...config, source: { ...config.source, assetVersion: 5 } },
    );
    expect(changedSource.parameters).toEqual({ duration: 42.25, custom: true });
    const unsetSource = applyVideoRecreationConfig(
      { ...next, parameters: { custom: true } },
      { ...config, source: { ...config.source, assetVersion: 5 } },
    );
    expect(unsetSource.parameters).toEqual({ duration: 8, custom: true });
    const alias = applyVideoRecreationConfig(
      { ...data, parameters: { durationSeconds: 7, custom: true } },
      config,
    );
    expect(alias.parameters).toEqual({ durationSeconds: 7, custom: true });
  });
  it('非整秒分析完整保存和提交，不省略或取整时长', () => {
    const fractional = {
      ...config,
      analysis: {
        ...config.analysis!,
        template: {
          ...config.analysis!.template,
          durationSeconds: 8.5,
          shots: [{ ...config.analysis!.template.shots[0]!, endSeconds: 8.5 }],
        },
      },
    };
    const next = applyVideoRecreationConfig({ ...data, parameters: {} }, fractional);
    expect(next.parameters?.duration).toBe(8.5);
    expect(next.prompt).toContain('【时长】：8.5s（原片 0–8.5s）');
    expect(recreationGenerationIssue(next)).toBeUndefined();
  });
  it('画布往返保留工作流，节点外框尺寸不受分析文字影响', () => {
    const canvas = canvasDocumentSchema.parse({
      revision: 2,
      nodes: [
        {
          id: 'recreate',
          type: 'video',
          position: { x: 4, y: 5 },
          width: 400,
          height: 266,
          data: applyVideoRecreationConfig(data, config),
        },
      ],
      edges: [],
    });
    const flow = fromCanvasDocument(canvas);
    const restored = toCanvasDocument(flow.nodes, flow.edges, 2);
    expect(restored.nodes[0]?.data.videoRecreation).toEqual(config);
    expect(restored.nodes[0]).toMatchObject({ width: 400, height: 266 });
  });
  it('混合保留和多商品替换往返保存，生成引用只包含所选冻结版本', () => {
    const objects: VideoRecreationConfig = {
      ...config,
      analysis: {
        ...config.analysis!,
        modelAlias: 'qwen3.8-omni-flash',
        credentialId: 'analysis-group',
        template: {
          ...config.analysis!.template,
          roles: [...config.analysis!.template.roles, { id: 'bystander', label: '配角' }],
          products: [
            { id: 'bottle', label: '饮料瓶', preview: { timestampSeconds: 2 } },
            { id: 'box', label: '包装盒' },
            { id: 'bag', label: '手提袋' },
          ],
        },
      },
      preservedRoleIds: ['bystander'],
      productBindings: [
        {
          productId: 'bottle',
          assetId: 'product',
          assetVersion: 3,
          name: '新包装',
          description: '饮料包装',
        },
        {
          productId: 'box',
          assetId: 'product',
          assetVersion: 3,
          name: '新包装',
          description: '外包装展示',
        },
      ],
    };
    const next = applyVideoRecreationConfig({ ...data, modelAlias: 'generation-model' }, objects);
    expect(next.resourceRefs).toEqual([
      expect.objectContaining({ assetId: 'face', assetVersion: 2, mediaType: 'image' }),
      expect.objectContaining({ assetId: 'product', assetVersion: 3, mediaType: 'image' }),
    ]);
    expect(next.prompt).toContain('配角（保留分析外观）');
    expect(next.prompt).toContain('手提袋（按分析描述保留）');
    expect(next.prompt).toContain('包装盒：新包装（沿用饮料瓶的参考图）');
    expect(next.modelAlias).toBe('generation-model');
    expect(recreationGenerationIssue(next)).toBeUndefined();
    const canvas = canvasDocumentSchema.parse({
      revision: 2,
      nodes: [
        {
          id: 'recreate',
          type: 'video',
          position: { x: 4, y: 5 },
          width: 400,
          height: 266,
          data: next,
        },
      ],
      edges: [],
    });
    const flow = fromCanvasDocument(canvas);
    const restored = toCanvasDocument(flow.nodes, flow.edges, 2);
    expect(restored.nodes[0]?.data.videoRecreation).toEqual(objects);
    expect(restored.nodes[0]?.data.resourceRefs).toEqual(next.resourceRefs);
    expect(restored.nodes[0]).toMatchObject({ width: 400, height: 266 });
  });
});
