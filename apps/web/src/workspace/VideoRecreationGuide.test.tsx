import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { VideoRecreationGuide } from './VideoRecreationGuide';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('短视频复刻使用流程', () => {
  it('直接展示使用流程标题和按顺序排列的四步操作与限制', () => {
    render(<VideoRecreationGuide />);

    expect(screen.getByRole('heading', { name: '使用流程' })).toBeVisible();
    const list = screen.getByRole('list', { name: '短视频复刻使用流程' });
    expect(list.tagName).toBe('OL');
    const steps = within(list).getAllByRole('listitem');
    expect(steps).toHaveLength(4);
    expect(steps.map((step) => step.querySelector('strong')?.textContent)).toEqual([
      '准备原视频',
      '分析整条视频',
      '提供人物',
      '检查并生成',
    ]);
    expect(steps[0]).toHaveTextContent('保留原视频。整条分析，无需选片段');
    expect(steps[1]).toHaveTextContent('点击「分析整条视频」，提取镜头、动作与节奏');
    expect(steps[2]).toHaveTextContent('人物必需：单人提供一张人物图，多人逐角色绑定');
    expect(steps[2]).toHaveTextContent('商品可选替换，默认保留');
    expect(steps[3]).toHaveTextContent('自动整理提示词，检查后点击「生成」');
    expect(steps[3]).toHaveTextContent('动作与镜头仅作参考，效果取决于模型');
    expect(
      screen.getByText('分析和生成均需你点击按钮才提交模型任务，不会自动付费。'),
    ).toBeVisible();
  });

  it('严格模式挂载、重绘和阅读均不发起请求，也不提供提交控件', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const user = userEvent.setup();
    const view = render(
      <StrictMode>
        <VideoRecreationGuide />
      </StrictMode>,
    );

    await user.click(screen.getByRole('heading', { name: '使用流程' }));
    await user.click(screen.getByText('检查并生成'));
    view.rerender(
      <StrictMode>
        <VideoRecreationGuide />
      </StrictMode>,
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('内容随宿主宽度换行，不给节点设置固定宽度或最小宽度', () => {
    const css = readFileSync('src/workspace/VideoRecreationGuide.css', 'utf8');
    const styles = css.match(/\.video-recreation-guide\s*\{([^}]+)\}/)?.[1];
    expect(styles).toContain('min-width: 0;');
    expect(styles).toContain('max-width: 100%;');
    expect(styles).toContain('overflow-wrap: anywhere;');
  });
});
