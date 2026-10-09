import { describe, expect, it } from 'vitest';
import type { CanvasDocument, CanvasNode } from '@multimodal-canvas/domain';
import { createRunSnapshot, snapshotFingerprint } from './runs';
import { validateRunImageParameters } from './run-image-parameters';

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

  it('目标提交覆盖同名保存值，图片尺寸能力交给上游判断', () => {
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
    ).not.toThrow();
  });

  it('检查间接图片祖先，但不替上游判断其能力', () => {
    const canvas = imageCanvas();
    addInvalidAncestor(canvas);

    expect(() =>
      validateRunImageParameters({ canvas, targetNodeId: 'image-target' }),
    ).not.toThrow();
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

  it('明确重跑手动输出目标时仍读取其生成参数并交给上游', () => {
    const canvas = imageCanvas();
    canvas.nodes[1].data.manualOutput = true;
    canvas.nodes[1].data.parameters = { quality: '4k', size: '1024x1024' };

    expect(() =>
      validateRunImageParameters({ canvas, targetNodeId: 'image-target' }),
    ).not.toThrow();
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
      ).not.toThrow();
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
