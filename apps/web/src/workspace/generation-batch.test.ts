import { describe, expect, it } from 'vitest';
import { canvasDocumentSchema } from '@multimodal-canvas/domain';
import { pasteCanvasClipboard, toCanvasDocument, type AssetFlowNode } from '../canvas-utils';
import { createGenerationBatch } from './generation-batch';

/** 带旧结果与输入引用的生成节点，用于检查每份结果的数据边界。 */
function sourceNode(count = 3): AssetFlowNode {
  return {
    id: 'source',
    type: 'image',
    position: { x: 0, y: 0 },
    width: 400,
    height: 266,
    data: {
      label: '样图',
      mediaType: 'image',
      mode: 'generate',
      generationCount: count,
      parameters: { size: '1024x1024' },
      prompt: 'Draw a new design.',
      modelAlias: 'image-model',
      credentialId: 'synthetic-credential',
      imageEditSource: { sourceNodeId: 'input', assetId: 'input-image', sourceKind: 'asset' },
      assetId: 'old-result',
      contentUrl: '/old.png',
      manualOutput: true,
      resultAsset: {
        assetId: 'old-result',
        version: 1,
        contentUrl: '/old.png',
        mimeType: 'image/png',
      },
    },
  };
}

describe('批量生成画布', () => {
  it('每份继承输入参数和边，但不继承产物或扩散生成数量', () => {
    const source = sourceNode();
    const input: AssetFlowNode = {
      id: 'input',
      type: 'image',
      position: { x: -500, y: 0 },
      data: { label: '原图', mediaType: 'image', mode: 'source', assetId: 'input-image' },
    };
    const edge = {
      id: 'edge',
      source: 'input',
      target: 'source',
      sourceHandle: 'output:image',
      targetHandle: 'input:content',
    };
    const result = createGenerationBatch(source, [input, source], [edge]);
    expect(result.targets).toHaveLength(3);
    expect(new Set(result.targets.map((node) => node.id)).size).toBe(3);
    expect(result.edges).toHaveLength(3);
    for (const sibling of result.targets.slice(1)) {
      expect(sibling.data).toMatchObject({
        parameters: source.data.parameters,
        imageEditSource: source.data.imageEditSource,
        generationCount: 1,
        modelAlias: 'image-model',
        credentialId: 'synthetic-credential',
      });
      expect(sibling.data.assetId).toBeUndefined();
      expect(sibling.data.resultAsset).toBeUndefined();
      expect(sibling.data.manualOutput).toBeUndefined();
      expect(sibling.width).toBe(400);
    }
    expect(
      canvasDocumentSchema.safeParse(toCanvasDocument(result.nodes, result.edges, 0)).success,
    ).toBe(true);
    expect(source.data.generationBatch).toBeUndefined();
  });

  it('再次批量生成保留旧成员与结果，并解除旧堆叠归属', () => {
    const source = sourceNode();
    const first = createGenerationBatch(source, [source], []);
    const next = createGenerationBatch(first.targets[0]!, first.nodes, first.edges);
    expect(next.nodes).toHaveLength(5);
    expect(
      next.nodes.find((node) => node.id === first.targets[1]!.id)?.data.generationBatch,
    ).toBeUndefined();
    expect(next.targets[0]!.data.resultAsset?.assetId).toBe('old-result');
  });

  it('历史节点只运行一次，非法数量不建立额外节点', () => {
    const source = sourceNode();
    delete source.data.generationCount;
    expect(createGenerationBatch(source, [source], []).targets).toEqual([source]);
    expect(() => createGenerationBatch(sourceNode(1.5), [source], [])).toThrow(RangeError);
  });

  it('粘贴整批重建归属，粘贴单个后方成员解除原批次关系', () => {
    const source = sourceNode();
    const batch = createGenerationBatch(source, [source], []);
    const copied = pasteCanvasClipboard({ nodes: batch.nodes, edges: [] });
    expect(copied.nodes[0]!.data.generationBatch?.id).not.toBe(
      batch.targets[0]!.data.generationBatch?.id,
    );
    expect(
      copied.nodes.every((node) => node.data.generationBatch?.rootNodeId === copied.nodes[0]!.id),
    ).toBe(true);
    const partial = pasteCanvasClipboard({ nodes: [batch.targets[1]!], edges: [] });
    expect(partial.nodes[0]!.data.generationBatch).toBeUndefined();
  });
});
