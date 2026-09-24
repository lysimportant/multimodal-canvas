import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunRecord } from '@multimodal-canvas/domain';
import type { AssetFlowNode } from '../canvas-utils';
import { RunPanel } from './RunPanel';
import type { RunResultState } from './useRunResultState';

/** 只提供运行面板读取的节点字段；测试不创建真实运行或供应商请求。 */
const node = {
  id: 'node-1',
  data: { label: '图片生成', mediaType: 'image', mode: 'generate' },
} as AssetFlowNode;
/** 当前结果身份独立于版本列表，避免迁移后打开错误版本。 */
const resultState: RunResultState = {
  versions: [],
  versionsLoading: false,
  versionsError: null,
  currentVersion: 2,
  currentContentUrl: 'https://assets.example/versions/2.png',
  currentPreviewAsset: {
    id: 'result-asset',
    name: '图片结果',
    mediaType: 'image',
    mimeType: 'image/png',
    status: 'ready',
    sizeBytes: 128,
    contentUrl: 'https://assets.example/versions/2.png',
    tags: [],
  },
};

afterEach(cleanup);

describe('RunPanel', () => {
  it('取消按钮使用共享 Button 且只提交一次取消回调', async () => {
    const onCancel = vi.fn();
    render(
      <RunPanel
        node={node}
        run={{ status: 'running' } as RunRecord}
        resultState={resultState}
        busy={false}
        onCancel={onCancel}
        onRetry={vi.fn()}
      />,
    );
    const cancel = screen.getByRole('button', { name: '取消运行' });
    expect(cancel).toHaveClass('ant-btn');
    expect(cancel).toHaveAttribute('type', 'button');
    await userEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it.each(['succeeded', 'failed', 'cancelled'] as const)('%s 终态不再暴露取消入口', (status) => {
    render(
      <RunPanel
        node={node}
        run={{ status } as RunRecord}
        resultState={resultState}
        busy={false}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: '取消运行' })).not.toBeInTheDocument();
  });

  it('版本列表失败仍保留当前媒体地址与错误回显', () => {
    render(
      <RunPanel
        node={node}
        run={{ status: 'succeeded', result: { summary: '生成完成' } } as RunRecord}
        resultState={{ ...resultState, versionsError: '暂时无法读取' }}
        busy={false}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByRole('link', { name: '打开结果' })).toHaveAttribute(
      'href',
      resultState.currentContentUrl,
    );
    expect(screen.getByRole('img', { name: '图片结果' })).toHaveAttribute(
      'src',
      resultState.currentContentUrl,
    );
    expect(screen.getByText('版本 2')).toBeInTheDocument();
    expect(
      screen.getByText('版本列表加载失败：暂时无法读取，仍显示当前结果。'),
    ).toBeInTheDocument();
    expect(screen.getByText('生成完成')).toBeInTheDocument();
  });
});
