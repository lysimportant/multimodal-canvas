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
    render(<CanvasNodeToolbar onAddGenerateNode={onGenerate} />);

    expect(screen.getAllByRole('button')).toHaveLength(4);
    expect(screen.queryByRole('button', { name: '新建视频转换节点' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '新建图片生成节点' }));

    expect(onGenerate).toHaveBeenCalledWith('image');
  });

  it('renders grouped canvas actions and forwards their callbacks', async () => {
    const user = userEvent.setup();
    const callbacks = {
      onUpload: vi.fn(),
      onClear: vi.fn(),
      onUndo: vi.fn(),
      onRedo: vi.fn(),
      onSearch: vi.fn(),
      onTheme: vi.fn(),
      onBackground: vi.fn(),
      onEdgePathStyle: vi.fn(),
      onEdgeEffect: vi.fn(),
      onFit: vi.fn(),
    };
    render(
      <CanvasNodeToolbar
        onAddGenerateNode={vi.fn()}
        onRequestUpload={callbacks.onUpload}
        onClearCanvas={callbacks.onClear}
        onUndoCanvas={callbacks.onUndo}
        onRedoCanvas={callbacks.onRedo}
        onOpenSearch={callbacks.onSearch}
        canvasTheme="eye-care"
        onThemeChange={callbacks.onTheme}
        canvasBackground="dots"
        onBackgroundChange={callbacks.onBackground}
        canvasEdgePathStyle="bezier"
        onEdgePathStyleChange={callbacks.onEdgePathStyle}
        canvasEdgeEffect="meteor"
        onEdgeEffectChange={callbacks.onEdgeEffect}
        onFitView={callbacks.onFit}
        canClearCanvas={false}
        canUndo={false}
        canRedo
      />,
    );

    expect(screen.getByRole('button', { name: '清空' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '画布撤销' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '画布重做' })).toBeEnabled();
    expect(screen.getByRole('group', { name: '创建节点' })).toBeVisible();
    expect(screen.getByRole('group', { name: '节点组' })).toBeVisible();
    expect(screen.getByRole('group', { name: '系统组' })).toBeVisible();
    expect(document.querySelectorAll('.canvas-node-tool-divider')).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: '上传资产' }));
    await user.click(screen.getByRole('button', { name: '画布重做' }));
    await user.click(screen.getByRole('button', { name: '搜索' }));
    await user.click(screen.getByRole('button', { name: '自动适配缩放' }));

    expect(callbacks.onUpload).toHaveBeenCalledTimes(1);
    expect(callbacks.onRedo).toHaveBeenCalledTimes(1);
    expect(callbacks.onSearch).toHaveBeenCalledTimes(1);
    expect(callbacks.onFit).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: '外观' }));
    const card = await screen.findByRole('dialog', { name: '主题、画布背景与连接线' });
    await waitFor(() => expect(card).toBeVisible());
    expect(card.closest('.ant-popover')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: '界面主题' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: '深色' }));
    expect(callbacks.onTheme).toHaveBeenCalledWith('dark');
    await user.click(screen.getByRole('tab', { name: '背景' }));
    expect(screen.getByRole('group', { name: '画布背景' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: '空白' }));
    expect(callbacks.onBackground).toHaveBeenCalledWith('blank');
    expect(screen.getByRole('tab', { name: '背景' })).toHaveAttribute('aria-selected', 'true');
    await user.click(screen.getByRole('tab', { name: '连接' }));
    expect(screen.getByRole('group', { name: '连接线路径' })).toBeVisible();
    expect(screen.getByRole('group', { name: '连接线特效' })).toBeVisible();
    expect(screen.getByRole('group', { name: '连接线组合预览' })).toBeVisible();
    expect(document.querySelectorAll('.appearance-edge-option')).toHaveLength(12);
    expect(document.querySelectorAll('[data-edge-path-style]')).toHaveLength(5);
    expect(document.querySelectorAll('[data-edge-effect]')).toHaveLength(7);
    // 每个选项与最终组合预览都使用真实路径预览，不是示意色块。
    expect(document.querySelectorAll('.appearance-edge-preview')).toHaveLength(13);
    expect(document.querySelectorAll('[data-edge-effect="meteor"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-edge-effect="shooting-star"]')).toHaveLength(1);
    /** 新增流星保持独立选项，且单条预览只有一个亮点，不替换原有流光。 */
    const shootingStar = screen.getByRole('button', { name: '单点流星 亮点携短尾迹' });
    expect(shootingStar.querySelectorAll('.canvas-edge-shooting-star-head')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: /圆角折线/ }));
    expect(callbacks.onEdgePathStyle).toHaveBeenCalledWith('smoothstep');
    expect(callbacks.onEdgeEffect).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /单点巡航/ }));
    expect(callbacks.onEdgeEffect).toHaveBeenCalledWith('cruiser');
    expect(callbacks.onEdgeEffect).toHaveBeenCalledTimes(1);
    await user.click(shootingStar);
    expect(callbacks.onEdgeEffect).toHaveBeenLastCalledWith('shooting-star');
    expect(callbacks.onEdgeEffect).toHaveBeenCalledTimes(2);
    expect(callbacks.onEdgePathStyle).toHaveBeenCalledTimes(1);
    expect(callbacks.onClear).not.toHaveBeenCalled();
    expect(callbacks.onUndo).not.toHaveBeenCalled();
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
