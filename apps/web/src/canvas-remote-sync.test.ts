import { describe, expect, it, vi } from 'vitest';
import type { CanvasDocument } from '@multimodal-canvas/domain';
import { fromCanvasDocument } from './canvas-utils';
import { mergeRemoteCanvasRuntime, remoteCanvasMatches } from './canvas-remote-sync';

function document(): CanvasDocument {
  return {
    revision: 1,
    nodes: [
      {
        id: 'a',
        type: 'text',
        position: { x: 0, y: 0 },
        data: {
          label: 'a',
          mode: 'generate',
          mediaType: 'text',
          parameters: { temperature: 0.5, maxTokens: 100 },
        },
      },
    ],
    edges: [],
  };
}

describe('远端画布内容与运行态', () => {
  it('不同 revision、对象键顺序、运行字段不构成内容冲突，判等不序列化整图', () => {
    const remote = document();
    const local = fromCanvasDocument(remote);
    local.nodes[0].data = {
      ...local.nodes[0].data,
      parameters: { maxTokens: 100, temperature: 0.5 },
      runStatus: 'running',
      runProgress: 70,
    };
    remote.revision = 9;
    const stringify = vi.spyOn(JSON, 'stringify');
    expect(remoteCanvasMatches(remote, local)).toBe(true);
    expect(stringify).not.toHaveBeenCalled();
    stringify.mockRestore();
  });

  it('提示词、参数或节点集合变化均不是可直接消除的冲突', () => {
    const remote = document();
    const local = fromCanvasDocument(remote);
    local.nodes[0].data.prompt = '本地新提示词';
    expect(remoteCanvasMatches(remote, local)).toBe(false);
    delete local.nodes[0].data.prompt;
    local.nodes[0].data.parameters = { temperature: 0.8, maxTokens: 100 };
    expect(remoteCanvasMatches(remote, local)).toBe(false);
    local.nodes = [];
    expect(remoteCanvasMatches(remote, local)).toBe(false);
  });

  it('远端修改节点位置后继续回显当前运行进度及旧结果', () => {
    const remote = document();
    const local = fromCanvasDocument(remote);
    local.nodes[0].data = {
      ...local.nodes[0].data,
      runStatus: 'running',
      runProgress: 62,
      resultAsset: { assetId: 'old-result', version: 1 },
    };
    remote.nodes[0].position = { x: 200, y: 80 };
    const next = mergeRemoteCanvasRuntime(remote, local, {});
    expect(next.nodes[0].position).toEqual({ x: 200, y: 80 });
    expect(next.nodes[0].data).toMatchObject({
      runStatus: 'running',
      runProgress: 62,
      resultAsset: { assetId: 'old-result' },
    });
    expect(local.nodes[0].position).toEqual({ x: 0, y: 0 });
  });

  it('远端显式手工替换产物时不附加旧的生成结果', () => {
    const remote = document();
    const local = fromCanvasDocument(remote);
    local.nodes[0].data.resultAsset = { assetId: 'old-result' };
    remote.nodes[0].data.manualOutput = true;
    remote.nodes[0].data.assetId = 'manual-new';
    expect(mergeRemoteCanvasRuntime(remote, local, {}).nodes[0].data.resultAsset).toBeUndefined();
  });
});
