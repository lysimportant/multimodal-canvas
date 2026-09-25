import type { NodeTiming } from '@multimodal-canvas/domain';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NodeDurationBadge, NODE_DURATION_TICK_MS, useSharedNodeClock } from './NodeDurationBadge';

/** 假时钟的执行起点；测试只推进本地时钟，不请求服务端。 */
const startedAt = '2026-09-25T10:00:00.000Z';

/** 模拟节点按运行状态订阅共享时钟，并把服务端参考时间交给展示组件。 */
function ClockedBadge({ timing, running = false }: { timing: NodeTiming; running?: boolean }) {
  const now = useSharedNodeClock(running);
  return <NodeDurationBadge timing={timing} now={now} running={running} />;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(startedAt));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('NodeDurationBadge 整秒计时', () => {
  it('运行中从 0 秒开始，每满一秒依次显示 1 秒、2 秒', () => {
    render(<ClockedBadge timing={{ nodeId: 'node-1', startedAt }} running />);
    expect(screen.getByText('0秒')).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(999));
    expect(screen.getByText('0秒')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByText('1秒')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(999));
    expect(screen.getByText('1秒')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByText('2秒')).toHaveClass('is-running');
  });

  it('开始时间与首次展示均不在整秒边界时，不显示小数或提前进位', () => {
    vi.setSystemTime(new Date('2026-09-25T10:00:00.950Z'));
    render(
      <ClockedBadge timing={{ nodeId: 'node-1', startedAt: '2026-09-25T10:00:00.350Z' }} running />,
    );
    expect(screen.getByText('0秒')).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByText('1秒')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByText('2秒')).toBeInTheDocument();
  });

  it('跨过 60 秒后仍逐秒递增，不切换为分钟或提前进位', () => {
    vi.setSystemTime(new Date('2026-09-25T10:00:59.900Z'));
    render(<ClockedBadge timing={{ nodeId: 'node-1', startedAt }} running />);
    expect(screen.getByText('59秒')).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByText('60秒')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByText('61秒')).toBeInTheDocument();
  });

  it.each([
    ['succeeded', '耗时'],
    ['failed', '失败耗时'],
    ['cancelled', '取消耗时'],
  ] as const)('%s 终态向下取整并冻结，释放最后一个计时订阅', (outcome, title) => {
    const { rerender } = render(<ClockedBadge timing={{ nodeId: 'node-1', startedAt }} running />);
    act(() => vi.advanceTimersByTime(2_999));
    expect(screen.getByText('2秒')).toBeInTheDocument();

    rerender(
      <ClockedBadge
        timing={{ nodeId: 'node-1', startedAt, finishedAt: new Date().toISOString(), outcome }}
      />,
    );
    expect(screen.getByTitle(`${title} 2秒`)).not.toHaveClass('is-running');
    expect(screen.getByText('2秒')).toBeInTheDocument();
    expect(document.querySelector('.node-duration-spinner')).not.toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);

    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByTitle(`${title} 2秒`)).toBeInTheDocument();
    expect(screen.getByText('2秒')).toBeInTheDocument();
  });

  it('旧结果的终态耗时不随仍在执行的新任务时钟增长', () => {
    render(
      <ClockedBadge
        timing={{
          nodeId: 'node-1',
          startedAt,
          finishedAt: '2026-09-25T10:00:12.400Z',
          outcome: 'succeeded',
        }}
        running
      />,
    );
    expect(screen.getByTitle('耗时 12秒')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByTitle('耗时 12秒')).toBeInTheDocument();
    expect(document.querySelector('.node-duration-spinner')).not.toBeInTheDocument();
  });

  it.each(['failed', 'cancelled'] as const)('%s 缺少终态时间时不冒充继续计时', (outcome) => {
    render(<ClockedBadge timing={{ nodeId: 'node-1', startedAt, outcome }} />);
    expect(screen.getByText('未记录')).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText('未记录')).toBeInTheDocument();
    expect(document.querySelector('.node-duration-spinner')).not.toBeInTheDocument();
  });

  it('排队但未开始时不显示推测耗时，真正开始后才从 0 秒递增', () => {
    const timing = { nodeId: 'node-1', queuedAt: '2026-09-25T09:59:50.000Z' };
    const { rerender } = render(<ClockedBadge timing={timing} running />);
    expect(screen.getByText('未记录')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.getByText('未记录')).toBeInTheDocument();

    rerender(<ClockedBadge timing={{ ...timing, startedAt: new Date().toISOString() }} running />);
    expect(screen.getByText('0秒')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByText('1秒')).toBeInTheDocument();
  });

  it.each([
    {
      title: '服务端时间顺序异常，耗时不可用',
      timing: { nodeId: 'node-1', startedAt, finishedAt: '2026-09-25T09:59:59.000Z' },
    },
    {
      title: '服务端时间戳晚于当前时间，耗时不可用',
      timing: { nodeId: 'node-1', startedAt: '2026-09-25T10:00:10.000Z' },
    },
  ])('$title，不将异常取整为 0 秒', ({ timing, title }) => {
    render(<ClockedBadge timing={timing} running />);
    expect(screen.getByTitle(title)).toHaveTextContent('耗时不可用');
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByTitle(title)).toHaveTextContent('耗时不可用');
    expect(screen.queryByText('0秒')).not.toBeInTheDocument();
  });

  it('无法解析的时间戳仍显示未记录', () => {
    render(<ClockedBadge timing={{ nodeId: 'node-1', startedAt: 'invalid' }} running />);
    expect(screen.getByText('未记录')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByText('未记录')).toBeInTheDocument();
  });

  it('多个节点共用一个每秒定时器，单个完成不影响其他节点，全部卸载后停止', () => {
    const setInterval = vi.spyOn(window, 'setInterval');
    const clearInterval = vi.spyOn(window, 'clearInterval');
    const { rerender, unmount } = render(
      <>
        <ClockedBadge timing={{ nodeId: 'node-1', startedAt }} running />
        <ClockedBadge timing={{ nodeId: 'node-2', startedAt }} running />
      </>,
    );
    expect(NODE_DURATION_TICK_MS).toBe(1_000);
    expect(setInterval).toHaveBeenCalledTimes(1);
    expect(setInterval).toHaveBeenCalledWith(expect.any(Function), 1_000);
    expect(vi.getTimerCount()).toBe(1);
    expect(screen.getAllByText('0秒')).toHaveLength(2);
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getAllByText('1秒')).toHaveLength(2);

    rerender(
      <>
        <ClockedBadge
          timing={{ nodeId: 'node-1', startedAt, finishedAt: new Date().toISOString() }}
        />
        <ClockedBadge timing={{ nodeId: 'node-2', startedAt }} running />
      </>,
    );
    expect(clearInterval).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByTitle('耗时 1秒')).toBeInTheDocument();
    expect(screen.getByText('2秒')).toHaveClass('is-running');
    expect(setInterval).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    expect(clearInterval).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
