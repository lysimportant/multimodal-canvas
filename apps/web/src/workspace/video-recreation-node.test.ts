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
/** 原节点参数必须保留非时长项，但不能继承上一个模型的五秒默认。 */
const data: FlowNodeData = {
  label: '复刻',
  mediaType: 'video',
  mode: 'generate',
  parameters: { duration: 5, resolution: '720p' },
  prompt: '旧人物描述',
};

describe('复刻节点集成数据', () => {
  it('一次更新配置、引用、英文提示词和全片时长', () => {
    const next = applyVideoRecreationConfig(data, config);
    expect(next.parameters).toEqual({ duration: 8, resolution: '720p' });
    expect(next.videoMode).toBe('omni_reference');
    expect(next.resourceRefs?.map((ref) => ref.assetId)).toEqual(['clip', 'face']);
    expect(next.prompt).not.toContain('旧人物描述');
    expect(recreationGenerationIssue(next)).toBeUndefined();
    expect(data.parameters?.duration).toBe(5);
  });
  it('重新分析和移除人物清空旧提示词，不能误用已生成模板', () => {
    const next = applyVideoRecreationConfig(data, { ...config, bindings: [] });
    expect(next.prompt).toBe('');
    expect(next.resourceRefs).toEqual([]);
    expect(recreationGenerationIssue(next)).toContain('主角');
    const pending = applyVideoRecreationConfig(data, {
      ...config,
      request: { idempotencyKey: 'same-key' },
    });
    expect(recreationGenerationIssue(pending)).toContain('原请求');
  });
  it('所有生成入口拒绝擅改时长或关闭参考视频模式', () => {
    const next = applyVideoRecreationConfig(data, config);
    expect(recreationGenerationIssue({ ...next, videoMode: 'text_to_video' })).toContain(
      '全能参考',
    );
    expect(recreationGenerationIssue({ ...next, parameters: { duration: 5 } })).toContain('时长');
    expect(recreationGenerationIssue(data)).toBeUndefined();
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
    const next = applyVideoRecreationConfig(data, fractional);
    expect(next.parameters?.duration).toBe(8.5);
    expect(next.prompt).toContain('Full observed duration: 8.5 seconds');
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
});
