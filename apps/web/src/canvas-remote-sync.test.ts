import { describe, expect, it, vi } from 'vitest';
import type { CanvasDocument, RunRecord } from '@multimodal-canvas/domain';
import { fromCanvasDocument } from './canvas-utils';
import { mergeRemoteCanvasRuntime, remoteCanvasMatches } from './canvas-remote-sync';

/** 最新一次运行失败：用于确认远端同步不复活旧结果的展示关联。 */
function failedRun(): RunRecord {
  return {
    id: 'run-new',
    projectId: 'synthetic',
    targetNodeId: 'a',
    status: 'failed',
    progress: 100,
    attempt: 1,
    provider: 'fixture',
    modelAlias: 'fixture',
    error: '上游任务失败',
    createdAt: '2026-10-03T00:00:00Z',
    updatedAt: '2026-10-03T00:00:05Z',
    snapshot: {
      projectId: 'synthetic',
      canvasRevision: 1,
      targetNodeId: 'a',
      modelAlias: 'fixture',
      parameters: {},
      submittedAt: '2026-10-03T00:00:00Z',
      nodes: [],
      edges: [],
      inputs: [],
    },
  };
}

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

  it('最新运行失败时远端同步不重新挂回旧结果，也不复用旧耗时', () => {
    const remote = document();
    const local = fromCanvasDocument(remote);
    local.nodes[0].data = {
      ...local.nodes[0].data,
      runStatus: 'succeeded',
      runId: 'run-old',
      nodeTiming: { nodeId: 'a', finishedAt: '2026-10-01T00:00:12Z' },
      resultAsset: { assetId: 'old-result', version: 1 },
      resultTiming: { nodeId: 'a', finishedAt: '2026-10-01T00:00:12Z' },
    };
    remote.nodes[0].position = { x: 200, y: 80 };
    const next = mergeRemoteCanvasRuntime(remote, local, { a: failedRun() });
    expect(next.nodes[0].position).toEqual({ x: 200, y: 80 });
    expect(next.nodes[0].data).toMatchObject({ runStatus: 'failed', runId: 'run-new' });
    expect(next.nodes[0].data.resultAsset).toBeUndefined();
    expect(next.nodes[0].data.resultTiming).toBeUndefined();
    expect(next.nodes[0].data.nodeTiming).toBeUndefined();
  });
});
