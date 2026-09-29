import { describe, expect, it } from 'vitest';
import type { CanvasDocument, CanvasNode } from '@multimodal-canvas/domain';
import { createRunSnapshot, snapshotFingerprint } from './runs';
import { RunImageParameterError, validateRunImageParameters } from './run-image-parameters';

/** 创建两级图片生成链；全部数据为合成值，不访问资源、凭据或供应商。 */
function imageCanvas(): CanvasDocument {
  return {
    revision: 3,
    nodes: [
      {
        id: 'image-upstream',
        type: 'image',
        position: { x: 0, y: 0 },
        data: {
          label: 'Upstream image',
          mediaType: 'image',
          mode: 'generate',
          parameters: { quality: 'high', size: '1024x1024' },
        },
      },
      {
        id: 'image-target',
        type: 'image',
        position: { x: 200, y: 0 },
        data: {
          label: 'Target image',
          mediaType: 'image',
          mode: 'generate',
          parameters: { quality: '4k', aspectRatio: '9:16' },
        },
      },
    ],
    edges: [
      {
        id: 'image-edge',
        sourceNodeId: 'image-upstream',
        sourceHandle: 'output:image',
        targetNodeId: 'image-target',
        targetHandle: 'input:referenceImage',
        order: 0,
      },
    ],
  };
}

/** 添加带有冲突参数的图片祖先，用于确认来源节点会截断执行闭包。 */
function addInvalidAncestor(canvas: CanvasDocument): void {
  const ancestor: CanvasNode = {
    id: 'image-ancestor',
    type: 'image',
    position: { x: -200, y: 0 },
    data: {
      label: 'Invalid ancestor',
      mediaType: 'image',
      mode: 'generate',
      parameters: { quality: '4k', size: '1024x1024' },
    },
  };
  canvas.nodes.push(ancestor);
  canvas.edges.push({
    id: 'ancestor-edge',
    sourceNodeId: ancestor.id,
    sourceHandle: 'output:image',
    targetNodeId: 'image-upstream',
    targetHandle: 'input:referenceImage',
    order: 0,
  });
}

describe('图片运行参数预检', () => {
  it('接受旧清晰度字段与原生质量、像素，不把根目标参数下发给上游', () => {
    const canvas = imageCanvas();
    const parameters = { quality: '4k', aspectRatio: '9:16', size: '2160x3840' };
    const before = structuredClone({ canvas, parameters });

    expect(() =>
      validateRunImageParameters({ canvas, targetNodeId: 'image-target', parameters }),
    ).not.toThrow();

    expect({ canvas, parameters }).toEqual(before);
    expect(canvas.nodes[1].data.parameters).not.toHaveProperty('size');
  });

  it('目标提交覆盖同名保存值，但部分提交仍需符合其它已保存参数', () => {
    const canvas = imageCanvas();
    expect(() =>
      validateRunImageParameters({
        canvas,
        targetNodeId: 'image-target',
        parameters: { quality: '2k', size: '1152x2048' },
      }),
    ).not.toThrow();

    expect(() =>
      validateRunImageParameters({
        canvas,
        targetNodeId: 'image-target',
        parameters: { size: '1024x1024' },
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'IMAGE_OUTPUT_PARAMETERS_INVALID',
        nodeId: 'image-target',
        parameter: 'size/resolution',
      }),
    );
  });

  it.each([
    { parameters: { resolution: '8k' }, parameter: 'resolution' },
    { parameters: { quality: '4k', size: '1024x1024' }, parameter: 'size/resolution' },
    {
      parameters: { aspectRatio: '9:16', aspect_ratio: '16:9' },
      parameter: 'aspectRatio/aspect_ratio',
    },
  ])('上游非法参数按自己的字段拒绝：$parameter', ({ parameters, parameter }) => {
    const canvas = imageCanvas();
    canvas.nodes[0].data.parameters = parameters;

    expect(() =>
      validateRunImageParameters({
        canvas,
        targetNodeId: 'image-target',
        parameters: { quality: '1k', aspectRatio: '1:1', size: '1024x1024' },
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'IMAGE_OUTPUT_PARAMETERS_INVALID',
        nodeId: 'image-upstream',
        parameter,
      }),
    );
  });

  it('检查间接图片祖先，不只检查目标及直接输入', () => {
    const canvas = imageCanvas();
    addInvalidAncestor(canvas);

    expect(() => validateRunImageParameters({ canvas, targetNodeId: 'image-target' })).toThrowError(
      expect.objectContaining({ nodeId: 'image-ancestor', parameter: 'size/resolution' }),
    );
  });

  it.each(['source', 'manualOutput', 'disabled', 'disconnected'] as const)(
    '不检查无需执行的 %s 图片及被截断的祖先',
    (reason) => {
      const canvas = imageCanvas();
      canvas.nodes[0].data.parameters = { quality: '4k', size: '1024x1024' };
      addInvalidAncestor(canvas);
      if (reason === 'source') canvas.nodes[0].data.mode = 'source';
      if (reason === 'manualOutput') canvas.nodes[0].data.manualOutput = true;
      if (reason === 'disabled') canvas.nodes[0].data.enabled = false;
      if (reason === 'disconnected') canvas.edges = [];

      expect(() =>
        validateRunImageParameters({ canvas, targetNodeId: 'image-target' }),
      ).not.toThrow();
    },
  );

  it('明确重跑手动输出目标时仍预检其生成参数', () => {
    const canvas = imageCanvas();
    canvas.nodes[1].data.manualOutput = true;
    canvas.nodes[1].data.parameters = { quality: '4k', size: '1024x1024' };

    expect(() => validateRunImageParameters({ canvas, targetNodeId: 'image-target' })).toThrowError(
      expect.objectContaining({ nodeId: 'image-target', parameter: 'size/resolution' }),
    );
  });

  it.each(['video', 'audio', 'text'] as const)(
    '非图片目标 %s 的同名参数不使用图片规则，也不污染图片上游',
    (mediaType) => {
      const canvas = imageCanvas();
      canvas.nodes[1].type = mediaType;
      canvas.nodes[1].data.mediaType = mediaType;
      canvas.nodes[1].data.parameters = { resolution: '720p', duration: 6 };

      expect(() =>
        validateRunImageParameters({
          canvas,
          targetNodeId: 'image-target',
          parameters: { resolution: '1080p', duration: 12 },
        }),
      ).not.toThrow();

      canvas.nodes[0].data.parameters = { quality: '4k', size: '1024x1024' };
      expect(() =>
        validateRunImageParameters({ canvas, targetNodeId: 'image-target' }),
      ).toThrowError(expect.objectContaining({ nodeId: 'image-upstream' }));
    },
  );

  it('未设置图片输出参数时不猜测模型能力或强制写入默认尺寸', () => {
    const canvas = imageCanvas();
    canvas.nodes.forEach((node) => delete node.data.parameters);

    expect(() =>
      validateRunImageParameters({ canvas, targetNodeId: 'image-target' }),
    ).not.toThrow();
    expect(canvas.nodes.every((node) => node.data.parameters === undefined)).toBe(true);
  });

  it('诊断携带节点和字段，但不回显非法参数原文', () => {
    const canvas = imageCanvas();
    canvas.nodes[1].data.parameters = { aspectRatio: 'synthetic-private-input' };

    try {
      validateRunImageParameters({ canvas, targetNodeId: 'image-target' });
      expect.fail('应拒绝非法比例');
    } catch (error) {
      expect(error).toBeInstanceOf(RunImageParameterError);
      if (!(error instanceof RunImageParameterError)) throw error;
      expect(error.nodeId).toBe('image-target');
      expect(error.parameter).toBe('aspectRatio');
      expect(error.message).not.toContain('synthetic-private-input');
    }
  });

  it.each([
    { quality: '1k', aspectRatio: '9:16' },
    { quality: '4k', aspectRatio: '1:1' },
  ])('使用 API 最终模型拒绝超出范围的 $quality $aspectRatio，而非节点旧别名', (parameters) => {
    const canvas = imageCanvas();
    canvas.nodes[1].data.modelAlias = 'synthetic-unrestricted-model';
    canvas.nodes[1].data.parameters = parameters;

    expect(() =>
      validateRunImageParameters({
        canvas,
        targetNodeId: 'image-target',
        nodeModelAliases: { 'image-target': 'gpt-image-2.5-sunburst' },
      }),
    ).toThrowError(expect.objectContaining({ nodeId: 'image-target', parameter: 'size' }));
  });

  it('最终模型是未知别名时只做中性解析，不沿用节点旧模型的尺寸限制', () => {
    const canvas = imageCanvas();
    canvas.nodes[1].data.modelAlias = 'gpt-image-2.5-sunburst';
    canvas.nodes[1].data.parameters = { quality: '4k', aspectRatio: '1:1' };

    expect(() =>
      validateRunImageParameters({
        canvas,
        targetNodeId: 'image-target',
        nodeModelAliases: { 'image-target': 'synthetic-unrestricted-model' },
      }),
    ).not.toThrow();
  });

  it('各上游使用自己的最终模型，不借用目标模型或漏查上游限制', () => {
    const canvas = imageCanvas();
    canvas.nodes[0].data.modelAlias = 'synthetic-old-upstream-model';
    canvas.nodes[0].data.parameters = { quality: '1k', aspectRatio: '9:16' };

    expect(() =>
      validateRunImageParameters({
        canvas,
        targetNodeId: 'image-target',
        nodeModelAliases: {
          'image-upstream': 'gpt-image-2.5-flare-2026-09-08',
          'image-target': 'synthetic-unrestricted-model',
        },
      }),
    ).toThrowError(expect.objectContaining({ nodeId: 'image-upstream', parameter: 'size' }));
  });

  it('没有 API 最终别名时使用节点已保存模型的尺寸合同', () => {
    const canvas = imageCanvas();
    canvas.nodes[1].data.modelAlias = 'gpt-image-2-2026-04-21';
    canvas.nodes[1].data.parameters = { quality: '4k', aspectRatio: '1:1' };

    expect(() => validateRunImageParameters({ canvas, targetNodeId: 'image-target' })).toThrowError(
      expect.objectContaining({ nodeId: 'image-target', parameter: 'size' }),
    );
  });

  it('只读校验旧快照所含参数，不规范化保存值或改变指纹', () => {
    const snapshot = createRunSnapshot('synthetic-project', imageCanvas(), 'image-target', {
      parameters: { quality: '4k', aspectRatio: '9:16' },
    });
    const before = structuredClone(snapshot);
    const fingerprint = snapshotFingerprint(snapshot);

    validateRunImageParameters({
      canvas: { revision: snapshot.canvasRevision, nodes: snapshot.nodes, edges: snapshot.edges },
      targetNodeId: snapshot.targetNodeId,
      parameters: snapshot.parameters,
    });

    expect(snapshot).toEqual(before);
    expect(snapshotFingerprint(snapshot)).toBe(fingerprint);
  });
});
