import { describe, expect, it } from 'vitest';
import type { Asset } from '@multimodal-canvas/domain';
import type { AssetFlowNode, FlowEdge } from '../canvas-utils';
import { summarizeConnectedVideoInputs } from './video-input-summary';

/** 合成生成来源，不读取真实画布或文件。 */
function source(id: string, assetId = id, version: number | undefined = 1): AssetFlowNode {
  return {
    id,
    type: 'image',
    position: { x: 0, y: 0 },
    data: { label: id, mediaType: 'image', mode: 'generate', resultAsset: { assetId, version } },
  };
}

function edge(node: AssetFlowNode, role = 'referenceImage'): FlowEdge {
  return {
    id: `${node.id}-${role}`,
    source: node.id,
    target: 'video',
    targetHandle: `input:${role}`,
  };
}

describe('summarizeConnectedVideoInputs', () => {
  it('纯文字来源无需资产即可贡献提示词，不误报素材缺失', () => {
    const text = source('text');
    text.type = 'text';
    text.data = {
      label: '文字提示词',
      mediaType: 'text',
      mode: 'source',
      prompt: '镜头从门口推进',
    };
    const summary = summarizeConnectedVideoInputs('video', [text], [edge(text, 'prompt')]);
    expect([...summary.counts]).toEqual([['prompt', 1]]);
    expect(summary.pending).toEqual([]);
  });

  it('六个停用旧来源和六个有效来源只显示六个参考图', () => {
    const active = Array.from({ length: 6 }, (_, index) => source(`active-${index}`));
    const disabled = active.map((node) => ({
      ...node,
      id: `disabled-${node.id}`,
      data: { ...node.data, enabled: false },
    }));
    const nodes = [...disabled, ...active];
    const summary = summarizeConnectedVideoInputs(
      'video',
      nodes,
      nodes.map((node) => edge(node)),
    );
    expect([...summary.counts]).toEqual([['referenceImage', 6]]);
    expect(summary.pending).toEqual([]);
  });

  it('同素材同版本同用途去重，不同版本及不同用途各保留一次', () => {
    const current = source('current', 'same', 2);
    const duplicate = source('duplicate', 'same', 2);
    const historical = source('historical', 'same', 1);
    const summary = summarizeConnectedVideoInputs(
      'video',
      [current, duplicate, historical],
      [edge(current), edge(duplicate), edge(historical), edge(current, 'firstFrame')],
    );
    expect([...summary.counts]).toEqual([
      ['referenceImage', 2],
      ['firstFrame', 1],
    ]);
    expect(summary.pending).toEqual([]);
  });

  it('缺素材和未知版本分别显示待补齐，未知版本不能因同资产而合并', () => {
    const missing = source('missing');
    delete missing.data.resultAsset;
    const unknown = ['unknown-a', 'unknown-b'].map((id) => {
      const node = source(id, 'same');
      delete node.data.resultAsset!.version;
      return node;
    });
    const nodes = [missing, ...unknown];
    const summary = summarizeConnectedVideoInputs(
      'video',
      nodes,
      nodes.map((node) => edge(node)),
    );
    expect(summary.counts.size).toBe(0);
    expect(summary.pending.map((item) => [item.label, item.reason])).toEqual([
      ['missing', '尚无素材'],
      ['unknown-a', '素材版本未知'],
      ['unknown-b', '素材版本未知'],
    ]);
  });

  it('手动替换的内容优先于旧生成结果，归档素材不计入有效引用', () => {
    const manual = source('manual', 'stale-result', 2);
    Object.assign(manual.data, {
      manualOutput: true,
      assetId: 'replacement',
      contentUrl: '/v1/assets/replacement/versions/1/content',
    });
    const same = source('replacement-source', 'replacement', 1);
    const archived = source('archived', 'archived', 1);
    const catalog: Asset = {
      id: 'archived',
      name: '已归档',
      mediaType: 'image',
      mimeType: 'image/png',
      status: 'ready',
      archivedAt: '2026-01-01T00:00:00.000Z',
      sizeBytes: 1,
      contentUrl: '/v1/assets/archived/content',
      tags: [],
      latestVersion: 1,
    };
    const nodes = [manual, same, archived];
    const summary = summarizeConnectedVideoInputs(
      'video',
      nodes,
      nodes.map((node) => edge(node)),
      [catalog],
    );
    expect([...summary.counts]).toEqual([['referenceImage', 1]]);
    expect(summary.pending).toMatchObject([{ nodeId: 'archived', reason: '素材不可用' }]);
  });
});
