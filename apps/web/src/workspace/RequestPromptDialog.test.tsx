import { ConfigProvider } from 'antd';
import '@testing-library/jest-dom/vitest';

import { cleanup, render as renderAntd, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RequestPromptDialog, type RequestPromptDialogState } from './RequestPromptDialog';
import { NodeDurationBadge, NODE_DURATION_TICK_MS, useSharedNodeClock } from './NodeDurationBadge';
import type { RequestPromptRecord } from '@multimodal-canvas/domain';

afterEach(cleanup);

/** 禁用库动画以同步检查可见性；仍渲染真实 Ant Design 控件和 portal。 */
const render = (ui: Parameters<typeof renderAntd>[0], options?: Parameters<typeof renderAntd>[1]) =>
  renderAntd(ui, {
    wrapper: ({ children }) => (
      <ConfigProvider theme={{ token: { motion: false } }}>{children}</ConfigProvider>
    ),
    ...options,
  });

/** 复制到剪贴板的测试替身，默认成功。 */
function stubClipboard(writeText: (value: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
}

/** 构造一份已归档的图片生成记录。 */
function record(overrides: Partial<RequestPromptRecord> = {}): RequestPromptRecord {
  return {
    schemaVersion: 1,
    runId: 'run-1',
    nodeId: 'node-1',
    attempt: 1,
    requestIdentity: 'POST /images/generations#1',
    provider: 'newapi',
    modelAlias: 'grok-image-1',
    mediaType: 'image',
    format: 'plain',
    parts: [{ order: 0, text: '月白布衫，青裙' }],
    resources: [],
    sendStatus: 'sent',
    createdAt: '2026-09-16T10:00:00.000Z',
    assetId: 'asset-1',
    assetVersion: 2,
    summary: '月白布衫，青裙，发髻松一缕。',
    ...overrides,
  };
}

describe('RequestPromptDialog', () => {
  beforeEach(() => {
    stubClipboard(() => Promise.resolve());
  });

  it('摘要与完整提示词分块显示，两份复制入口互不影响', async () => {
    const written: string[] = [];
    stubClipboard((value) => {
      written.push(value);
      return Promise.resolve();
    });
    render(<RequestPromptDialog state={{ status: 'ready', record: record() }} onClose={vi.fn()} />);

    expect(screen.getByRole('dialog', { name: '生成提示词' })).toBeInTheDocument();
    expect(screen.getByText('月白布衫，青裙，发髻松一缕。')).toBeInTheDocument();
    expect(screen.getByText('月白布衫，青裙')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '复制摘要' }));
    await waitFor(() => expect(written).toEqual(['月白布衫，青裙，发髻松一缕。']));
    await userEvent.click(screen.getByRole('button', { name: '复制完整提示词' }));
    await waitFor(() =>
      expect(written).toEqual(['月白布衫，青裙，发髻松一缕。', '月白布衫，青裙']),
    );
  });

  it('多消息结果复制文本保留角色分隔与顺序', async () => {
    const written: string[] = [];
    stubClipboard((value) => {
      written.push(value);
      return Promise.resolve();
    });
    render(
      <RequestPromptDialog
        state={{
          status: 'ready',
          record: record({
            mediaType: 'text',
            format: 'messages',
            parts: [
              { order: 1, role: 'user', name: '参考图说明', text: '保持配色' },
              { order: 0, role: 'user', text: '写一段开头' },
            ],
          }),
        }}
        onClose={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: '复制完整提示词' }));
    await waitFor(() => expect(written[0]).toBe('[user] 写一段开头\n[user:参考图说明] 保持配色'));
  });

  it('剪贴板失败时显示错误，不谎报成功', async () => {
    stubClipboard(() => Promise.reject(new Error('denied')));
    render(<RequestPromptDialog state={{ status: 'ready', record: record() }} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: '复制摘要' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '复制摘要' })).toHaveTextContent('复制失败'),
    );
    // 文本仍可选中。
    expect(screen.getByText('月白布衫，青裙')).toBeInTheDocument();
  });

  it('缺失摘要时明确提示，不把截断当总结，也不影响完整提示词', () => {
    render(
      <RequestPromptDialog
        state={{ status: 'ready', record: record({ summary: undefined }) }}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/尚未记录摘要/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '复制摘要' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '复制完整提示词' })).toBeEnabled();
  });

  it('添加摘要只提交摘要草稿，完整真实请求文本仍只读且可复制', async () => {
    const onSaveSummary = vi.fn().mockResolvedValue(undefined);
    const original = record({ summary: undefined });
    render(
      <RequestPromptDialog
        state={{ status: 'ready', record: original }}
        onClose={vi.fn()}
        onSaveSummary={onSaveSummary}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: '添加摘要' }));
    const editor = screen.getByRole('textbox', { name: '摘要正文' });
    expect(editor).toHaveFocus();
    await userEvent.type(editor, '素雅的古风人物着装。');
    await userEvent.click(screen.getByRole('button', { name: '保存摘要' }));
    await waitFor(() => expect(onSaveSummary).toHaveBeenCalledWith('素雅的古风人物着装。'));
    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
    expect(document.querySelector('.request-prompt-text')).toHaveTextContent('月白布衫，青裙');
    expect(original.parts).toEqual([{ order: 0, text: '月白布衫，青裙' }]);
  });

  it('编辑失败保留草稿并允许重试，取消不会保存', async () => {
    const onSaveSummary = vi
      .fn()
      .mockRejectedValueOnce(new Error('网络中断'))
      .mockResolvedValue(undefined);
    render(
      <RequestPromptDialog
        state={{ status: 'ready', record: record() }}
        onClose={vi.fn()}
        onSaveSummary={onSaveSummary}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: '编辑摘要' }));
    const editor = screen.getByRole('textbox', { name: '摘要正文' });
    await userEvent.clear(editor);
    await userEvent.type(editor, '新摘要');
    await userEvent.click(screen.getByRole('button', { name: '保存摘要' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('网络中断');
    expect(editor).toHaveValue('新摘要');
    await userEvent.click(screen.getByRole('button', { name: '保存摘要' }));
    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
    expect(onSaveSummary).toHaveBeenCalledTimes(2);
    await userEvent.click(screen.getByRole('button', { name: '编辑摘要' }));
    await userEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onSaveSummary).toHaveBeenCalledTimes(2);
  });

  it('切换资产记录重置草稿并显示对应结果耗时', async () => {
    const onSaveSummary = vi.fn();
    const view = render(
      <RequestPromptDialog
        state={{ status: 'ready', record: record() }}
        onClose={vi.fn()}
        onSaveSummary={onSaveSummary}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: '编辑摘要' }));
    await userEvent.type(screen.getByRole('textbox', { name: '摘要正文' }), '未保存');
    view.rerender(
      <RequestPromptDialog
        state={{
          status: 'ready',
          record: record({ runId: 'older-run', assetVersion: 1 }),
          timing: {
            nodeId: 'node-1',
            startedAt: '2026-09-16T10:00:00.000Z',
            finishedAt: '2026-09-16T10:00:04.500Z',
            outcome: 'succeeded',
          },
        }}
        onClose={vi.fn()}
        onSaveSummary={onSaveSummary}
      />,
    );
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText('asset-1 · v1')).toBeInTheDocument();
    expect(screen.getByText('4秒')).toBeInTheDocument();
    expect(onSaveSummary).not.toHaveBeenCalled();
  });

  it('模型、生成时间与结果版本显示在紧凑信息行', () => {
    render(<RequestPromptDialog state={{ status: 'ready', record: record() }} onClose={vi.fn()} />);
    expect(screen.getByText('grok-image-1')).toBeInTheDocument();
    expect(screen.getByText('asset-1 · v2')).toBeInTheDocument();
  });

  it('未关联结果时明确说明，不伪造版本', () => {
    render(
      <RequestPromptDialog
        state={{ status: 'ready', record: record({ assetId: undefined, assetVersion: undefined }) }}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText('未关联结果')).toBeInTheDocument();
  });

  it('加载、失败可重试与无记录三种状态都可理解', async () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <RequestPromptDialog state={{ status: 'loading' }} onClose={vi.fn()} />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('正在读取生成说明');

    rerender(
      <RequestPromptDialog
        state={{ status: 'failed', message: '网络不可用' }}
        onClose={vi.fn()}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('网络不可用');
    await userEvent.click(screen.getByRole('button', { name: /重试/ }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    rerender(<RequestPromptDialog state={{ status: 'missing' }} onClose={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('未记录生成提示词');
  });

  it('Esc 关闭并把焦点还给触发按钮，Tab 焦点圈定在 Dialog 内', async () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <div>
        <button type="button" id="prompt-trigger">
          提示词
        </button>
        <RequestPromptDialog
          state={{ status: 'ready', record: record() }}
          triggerId="prompt-trigger"
          onClose={onClose}
        />
      </div>,
    );
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveFocus());
    await userEvent.tab();
    expect(screen.getByRole('button', { name: '关闭生成提示词' })).toHaveFocus();

    await userEvent.tab();
    expect(screen.getByRole('button', { name: '复制摘要' })).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(screen.getByRole('button', { name: '关闭生成提示词' })).toHaveFocus();

    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(
      <div>
        <button type="button" id="prompt-trigger">
          提示词
        </button>
        <RequestPromptDialog
          state={{ status: 'ready', record: record() }}
          open={false}
          triggerId="prompt-trigger"
          onClose={onClose}
        />
      </div>,
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: '提示词' })).toHaveFocus());
  });

  it('长提示词与长 URL 不改变节点外壳：正文放在独立滚动容器内', () => {
    const long = `${'很长的提示词'.repeat(400)}\nhttps://example.com/${'a'.repeat(300)}`;
    render(
      <RequestPromptDialog
        state={{ status: 'ready', record: record({ parts: [{ order: 0, text: long }] }) }}
        onClose={vi.fn()}
      />,
    );
    // Dialog 渲染到 document.body：节点信息面板打开时不能被它的模态区域吞掉指针事件。
    expect(document.querySelector('.request-prompt-body')).toBeInTheDocument();
    expect(screen.getByText(/很长的提示词/)).toBeInTheDocument();
  });
});

describe('NodeDurationBadge', () => {
  it('终态显示 frozen 耗时并按终态性质标注', () => {
    const { rerender } = render(
      <NodeDurationBadge
        timing={{
          nodeId: 'node-1',
          startedAt: '2026-09-16T10:00:00.000Z',
          finishedAt: '2026-09-16T10:00:12.400Z',
          outcome: 'succeeded',
        }}
        now={Date.parse('2026-09-16T10:05:00.000Z')}
      />,
    );
    expect(screen.getByText('12秒')).toBeInTheDocument();

    rerender(
      <NodeDurationBadge
        timing={{
          nodeId: 'node-1',
          startedAt: '2026-09-16T10:00:00.000Z',
          finishedAt: '2026-09-16T10:02:08.000Z',
          outcome: 'failed',
        }}
        now={Date.parse('2026-09-16T10:05:00.000Z')}
      />,
    );
    expect(screen.getByText('128秒')).toBeInTheDocument();
    expect(screen.getByTitle('失败耗时 128秒')).toBeInTheDocument();
  });

  it('运行中显示已用时间，长时间显示不改变文本结构', () => {
    render(
      <NodeDurationBadge
        timing={{ nodeId: 'node-1', startedAt: '2026-09-16T10:00:00.000Z' }}
        now={Date.parse('2026-09-16T10:00:03.200Z')}
        running
      />,
    );
    expect(screen.getByText('3秒')).toBeInTheDocument();
    expect(document.querySelector('.node-duration-badge.is-running')).not.toBeNull();
  });

  it('未执行或缺少时间戳显示未记录，不显示 0 秒', () => {
    const { rerender } = render(<NodeDurationBadge now={Date.now()} />);
    expect(screen.getByText('未记录')).toBeInTheDocument();

    rerender(<NodeDurationBadge timing={{ nodeId: 'node-1' }} now={Date.now()} />);
    expect(screen.getByText('未记录')).toBeInTheDocument();
    expect(screen.queryByText('0秒')).not.toBeInTheDocument();
  });

  it('已结束的结果缺少终态时间时不冒充仍在执行', () => {
    render(
      <NodeDurationBadge
        timing={{ nodeId: 'node-1', startedAt: '2026-09-16T10:00:00.000Z' }}
        now={Date.parse('2026-09-16T10:05:00.000Z')}
      />,
    );
    expect(screen.getByText('未记录')).toBeInTheDocument();
    expect(document.querySelector('.node-duration-spinner')).not.toBeInTheDocument();
  });

  it('时间顺序异常标记不可用，避免负数', () => {
    render(
      <NodeDurationBadge
        timing={{
          nodeId: 'node-1',
          startedAt: '2026-09-16T10:00:10.000Z',
          finishedAt: '2026-09-16T10:00:00.000Z',
        }}
        now={Date.now()}
      />,
    );
    expect(screen.getByText('耗时不可用')).toBeInTheDocument();
  });
});

describe('useSharedNodeClock', () => {
  /** 只用于观察共享时钟的最小宿主组件。 */
  function ClockProbe({ enabled }: { enabled: boolean }) {
    const now = useSharedNodeClock(enabled);
    return <span data-testid="clock">{Math.round(now / 1000)}</span>;
  }

  it('只创建一个定时器，禁用时不订阅', () => {
    const setInterval = vi.spyOn(window, 'setInterval');
    const { rerender, unmount } = render(<ClockProbe enabled />);
    expect(setInterval).toHaveBeenCalledTimes(1);
    expect(setInterval.mock.calls[0]?.[1]).toBe(NODE_DURATION_TICK_MS);

    rerender(<ClockProbe enabled={false} />);
    expect(window.setInterval).toHaveBeenCalledTimes(1);

    unmount();
    setInterval.mockRestore();
  });

  it('多个订阅者共用一个定时器，全部取消后停止空转', () => {
    const setInterval = vi.spyOn(window, 'setInterval');
    const clearInterval = vi.spyOn(window, 'clearInterval');
    const { unmount } = render(
      <>
        <ClockProbe enabled />
        <ClockProbe enabled />
        <ClockProbe enabled />
      </>,
    );
    expect(setInterval).toHaveBeenCalledTimes(1);
    expect(clearInterval).not.toHaveBeenCalled();

    unmount();
    expect(clearInterval).toHaveBeenCalledTimes(1);
    setInterval.mockRestore();
    clearInterval.mockRestore();
  });
});
