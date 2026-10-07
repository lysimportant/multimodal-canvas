import { describe, expect, it, vi } from 'vitest';
import type { CanvasDocument } from '@multimodal-canvas/domain';
import { createRunSnapshot, MemoryRunService, snapshotFingerprint } from './runs';

/** 创建带有独立上游参数和目标推理强度的合成画布，不访问外部服务。 */
function parameterCanvas(): CanvasDocument {
  return {
    revision: 5,
    nodes: [
      {
        id: 'image-upstream',
        type: 'image',
        position: { x: 0, y: 0 },
        data: {
          label: 'Upstream',
          mediaType: 'image',
          mode: 'generate',
          modelAlias: 'synthetic-upstream-model',
          parameters: { quality: '1k', seed: 99, upstreamOnly: true },
        },
      },
      {
        id: 'image-target',
        type: 'image',
        position: { x: 200, y: 0 },
        data: {
          label: 'Target',
          mediaType: 'image',
          mode: 'generate',
          modelAlias: 'synthetic-target-model',
          parameters: {
            quality: '4k',
            aspectRatio: '9:16',
            seed: 17,
            useWatermark: true,
            inferenceStrength: 'low',
          },
          inferenceStrength: 'high',
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

describe('运行参数冻结', () => {
  it('原样冻结 canonical 图片 size 与真实 quality，保留其它字段和假值', () => {
    const canvas = parameterCanvas();
    const parameters = {
      size: '2160x3840',
      quality: 'high',
      seed: 0,
      useWatermark: false,
      providerOption: '',
    };
    canvas.nodes[1].data.parameters = structuredClone(parameters);
    delete canvas.nodes[1].data.inferenceStrength;
    const before = structuredClone(canvas);

    const snapshot = createRunSnapshot('synthetic-project', canvas, 'image-target');

    expect(snapshot.parameters).toEqual(parameters);
    expect(snapshot.nodes[1].data.parameters).toEqual(parameters);
    expect(canvas).toEqual(before);
  });

  it.each([
    { name: '省略提交', parameters: undefined },
    { name: '提交空对象', parameters: {} },
  ])('$name 时冻结目标保存值，独立推理强度覆盖参数记录中的旧值', ({ parameters }) => {
    const canvas = parameterCanvas();
    const snapshot = createRunSnapshot('synthetic-project', canvas, 'image-target', { parameters });

    expect(snapshot.parameters).toEqual({
      quality: '4k',
      aspectRatio: '9:16',
      seed: 17,
      useWatermark: true,
      inferenceStrength: 'high',
    });
    expect(snapshot.parameters).not.toHaveProperty('upstreamOnly');
    expect(snapshot.nodes[0].data.parameters).toEqual(canvas.nodes[0].data.parameters);
  });

  it('部分提交仅覆盖同名字段，0、false 和提交推理强度保持最高优先级', () => {
    const canvas = parameterCanvas();
    const parameters = { seed: 0, useWatermark: false, inferenceStrength: 'max' };
    const before = structuredClone({ canvas, parameters });

    const snapshot = createRunSnapshot('synthetic-project', canvas, 'image-target', { parameters });

    expect(snapshot.parameters).toEqual({
      quality: '4k',
      aspectRatio: '9:16',
      seed: 0,
      useWatermark: false,
      inferenceStrength: 'max',
    });
    expect({ canvas, parameters }).toEqual(before);
    expect(snapshot.nodes[1].data.parameters).toEqual(before.canvas.nodes[1].data.parameters);
    expect(snapshot.nodes[1].data.inferenceStrength).toBe('high');
  });

  it('没有独立推理强度时保留参数记录本身的值', () => {
    const canvas = parameterCanvas();
    delete canvas.nodes[1].data.inferenceStrength;

    expect(createRunSnapshot('synthetic-project', canvas, 'image-target').parameters).toMatchObject(
      {
        inferenceStrength: 'low',
      },
    );
  });

  it('深拷贝保存参数及提交参数，后续嵌套对象和数组变更不影响冻结快照', () => {
    const canvas = parameterCanvas();
    const storedLayout = { padding: 8 };
    canvas.nodes[1].data.parameters!.layout = storedLayout;
    const parameters = { response: { format: 'png', levels: [0, 1] } };
    const expected = {
      ...structuredClone(canvas.nodes[1].data.parameters),
      inferenceStrength: 'high',
      ...structuredClone(parameters),
    };
    const snapshot = createRunSnapshot('synthetic-project', canvas, 'image-target', { parameters });
    const fingerprint = snapshotFingerprint(snapshot);

    storedLayout.padding = 32;
    canvas.nodes[1].data.parameters!.quality = '1k';
    parameters.response.format = 'jpeg';
    parameters.response.levels.push(2);

    expect(snapshot.parameters).toEqual(expected);
    expect(snapshot.nodes[1].data.parameters).toMatchObject({
      quality: '4k',
      layout: { padding: 8 },
    });
    expect(snapshotFingerprint(snapshot)).toBe(fingerprint);
  });

  it('根参数与冻结节点记录不共享嵌套对象', () => {
    const canvas = parameterCanvas();
    canvas.nodes[1].data.parameters!.layout = { padding: 8 };
    const snapshot = createRunSnapshot('synthetic-project', canvas, 'image-target');

    expect(snapshot.parameters).toHaveProperty('layout.padding', 8);
    (snapshot.parameters.layout as { padding: number }).padding = 32;

    expect(snapshot.nodes[1].data.parameters).toHaveProperty('layout.padding', 8);
    expect(canvas.nodes[1].data.parameters).toHaveProperty('layout.padding', 8);
  });

  it('旧节点没有任何生成参数时仍得到空参数记录', () => {
    const canvas = parameterCanvas();
    delete canvas.nodes[1].data.parameters;
    delete canvas.nodes[1].data.inferenceStrength;

    expect(createRunSnapshot('synthetic-project', canvas, 'image-target').parameters).toEqual({});
  });

  it('内存重试复用旧快照的空根参数和指纹，不按新冻结规则回填历史数据', async () => {
    const legacy = createRunSnapshot('synthetic-project', parameterCanvas(), 'image-target');
    legacy.parameters = {};
    const before = structuredClone(legacy);
    const fingerprint = snapshotFingerprint(legacy);
    const service = new MemoryRunService({
      stepDelayMs: 0,
      executor: async () => {
        throw new Error('synthetic failure without a provider request');
      },
    });
    try {
      const run = await service.create(legacy);
      await vi.waitFor(async () => expect((await service.get(run.id))?.status).toBe('failed'));

      const retried = await service.retry(run.id);

      expect(retried.snapshot).toEqual(before);
      expect(retried.snapshot.parameters).toEqual({});
      expect(snapshotFingerprint(retried.snapshot)).toBe(fingerprint);
      expect((await service.get(run.id))?.snapshot).toEqual(before);
    } finally {
      await service.close();
    }
  });
});
