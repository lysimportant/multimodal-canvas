import '@testing-library/jest-dom/vitest';

import { cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RunRecord } from '@multimodal-canvas/domain';
import type { AssetFlowNode } from '../canvas-utils';
import { CanvasNodeToolbar } from './CanvasNodeToolbar';
import { RunPanel } from './RunPanel';
import { useRunResultState, type RunResultState } from './useRunResultState';

const imageNode = {
  id: 'node_image',
  type: 'image',
  position: { x: 0, y: 0 },
  data: {
    label: '图片生成节点',
    mediaType: 'image',
    mode: 'generate',
    enabled: true,
  },
} as AssetFlowNode;

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run_1',
    projectId: 'project_1',
    nodeId: imageNode.id,
    status: 'running',
    progress: 35,
    snapshot: { inputs: [] } as unknown as RunRecord['snapshot'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as RunRecord;
}

function emptyResultState(overrides: Partial<RunResultState> = {}): RunResultState {
  return {
    versions: [],
    versionsLoading: false,
    versionsError: null,
    currentVersion: 1,
    currentPreviewAsset: {
      id: 'result',
      name: '图片生成节点结果',
      mediaType: 'image',
      mimeType: 'image/png',
      sizeBytes: 0,
      status: 'ready',
      contentUrl: '',
      tags: [],
    },
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('workspace modules', () => {
  it('keeps the node toolbar independently actionable for every media type', async () => {
    const user = userEvent.setup();
    const onGenerate = vi.fn();
    const onTransform = vi.fn();
    render(<CanvasNodeToolbar onAddGenerateNode={onGenerate} onAddTransformNode={onTransform} />);

    expect(screen.getAllByRole('button')).toHaveLength(8);
    await user.click(screen.getByRole('button', { name: '新建图片生成节点' }));
    await user.click(screen.getByRole('button', { name: '新建视频转换节点' }));

    expect(onGenerate).toHaveBeenCalledWith('image');
    expect(onTransform).toHaveBeenCalledWith('video');
  });

  it('keeps cancellation inside the independent run panel', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <RunPanel
        node={imageNode}
        run={makeRun()}
        resultState={emptyResultState()}
        busy={false}
        onCancel={onCancel}
        onRetry={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: '取消运行' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('derives the current archived result version in an independent state hook', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          versions: [
            {
              id: 'version_1',
              assetId: 'asset_result',
              version: 1,
              sizeBytes: 10,
              createdAt: '2026-08-27T00:00:00.000Z',
              contentUrl: '/v1/assets/asset_result/versions/1/content',
            },
            {
              id: 'version_2',
              assetId: 'asset_result',
              version: 2,
              sizeBytes: 20,
              createdAt: '2026-08-27T00:01:00.000Z',
              contentUrl: '/v1/assets/asset_result/versions/2/content',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const run = makeRun({
      status: 'succeeded',
      progress: 100,
      result: {
        provider: 'mock',
        mediaType: 'image',
        targetNodeId: imageNode.id,
        inputCount: 0,
        summary: '完成',
        asset: {
          assetId: 'asset_result',
          version: 2,
          mimeType: 'image/png',
          sizeBytes: 20,
          contentUrl: '/v1/assets/asset_result/versions/2/content',
        },
      },
    });

    const { result } = renderHook(() => useRunResultState(imageNode, run));
    await waitFor(() => expect(result.current.versionsLoading).toBe(false));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.currentVersion).toBe(2);
    expect(result.current.versions).toHaveLength(2);
    expect(result.current.currentPreviewAsset.contentUrl).toContain('/versions/2/content');
  });
});
