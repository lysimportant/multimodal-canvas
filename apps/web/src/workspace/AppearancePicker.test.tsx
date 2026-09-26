import '@testing-library/jest-dom/vitest';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppearancePicker } from './AppearancePicker';
import { canvasEdgePreviewPath } from './canvas-edge-appearance';

afterEach(cleanup);

describe('AppearancePicker', () => {
  it('连接卡片按内容撑高，标题与说明允许换行且不依赖 important 覆盖', () => {
    const css = readFileSync(
      resolve(process.cwd(), 'src/workspace/AppearancePicker.css'),
      'utf8',
    ).replace(/\s+/g, ' ');

    expect(css).toMatch(
      /\.appearance-antd-popover \.appearance-edge-option\.ant-btn \{[^}]*height: auto;/,
    );
    expect(css).toMatch(/\.appearance-edge-option small \{[^}]*white-space: normal;/);
    expect(css).toMatch(/\.appearance-edge-options \{[^}]*gap: 8px;/);
    expect(css).toMatch(
      /\.appearance-antd-popover \.ant-tabs-content \{[^}]*max-height: min\([^;]+;[^}]*overflow-y: auto;/,
    );
    expect(css).not.toContain('!important');
  });

  it('单点流星独立于旧流光，选项与组合预览共用真实路径和同一特效层', async () => {
    const user = userEvent.setup();
    const props = {
      canvasTheme: 'eye-care' as const,
      canvasBackground: 'dots' as const,
      canvasEdgePathStyle: 'step' as const,
      placement: 'bottom' as const,
      onThemeChange: vi.fn(),
      onBackgroundChange: vi.fn(),
      onEdgePathStyleChange: vi.fn(),
      onEdgeEffectChange: vi.fn(),
    };
    const { rerender } = render(<AppearancePicker {...props} canvasEdgeEffect="meteor" />);
    await user.click(screen.getByRole('button', { name: '外观' }));
    const dialog = await screen.findByRole('dialog', { name: '主题、画布背景与连接线' });
    await user.click(within(dialog).getByRole('tab', { name: '连接' }));
    expect(dialog.querySelector('.ant-tabs-content-active')).toContainElement(
      within(dialog).getByRole('group', { name: '连接线特效' }),
    );

    const meteor = within(dialog).getByRole('button', { name: '流光 短亮线行进' });
    const shootingStar = within(dialog).getByRole('button', { name: '单点流星 亮点携短尾迹' });
    expect(meteor).toHaveAttribute('aria-pressed', 'true');
    expect(meteor.querySelector('.canvas-edge-effect-meteor')).toBeInTheDocument();
    expect(shootingStar).toHaveAttribute('aria-pressed', 'false');
    expect(shootingStar.querySelectorAll('.canvas-edge-shooting-star-head')).toHaveLength(1);
    expect(shootingStar.querySelector('strong')).toHaveTextContent('单点流星');
    expect(shootingStar.querySelector('small')).toHaveTextContent('亮点携短尾迹');

    await user.click(shootingStar);
    expect(props.onEdgeEffectChange).toHaveBeenCalledExactlyOnceWith('shooting-star');
    expect(props.onEdgePathStyleChange).not.toHaveBeenCalled();
    rerender(<AppearancePicker {...props} canvasEdgeEffect="shooting-star" />);
    expect(shootingStar).toHaveAttribute('aria-pressed', 'true');
    expect(meteor).toHaveAttribute('aria-pressed', 'false');

    const combined = within(dialog).getByRole('group', { name: '连接线组合预览' });
    const expectedPath = canvasEdgePreviewPath('step');
    expect(combined.querySelectorAll('.canvas-edge-shooting-star-head')).toHaveLength(1);
    combined.querySelectorAll('path').forEach((path) => {
      expect(path).toHaveAttribute('d', expectedPath);
    });
    within(dialog)
      .getByRole('group', { name: '连接线路径' })
      .querySelectorAll('.appearance-edge-option')
      .forEach((option) => {
        const base = option.querySelector('.canvas-flow-edge-path');
        option.querySelectorAll('.canvas-edge-effect-shooting-star path').forEach((path) => {
          expect(path).toHaveAttribute('d', base?.getAttribute('d'));
        });
      });

    await user.click(within(dialog).getByRole('button', { name: '直线 两端直连' }));
    expect(props.onEdgePathStyleChange).toHaveBeenCalledExactlyOnceWith('straight');
    expect(props.onEdgeEffectChange).toHaveBeenCalledTimes(1);
  });

  it('真实 Popover 保留主题、背景与连接的独立选择和组合预览', async () => {
    const user = userEvent.setup();
    const onThemeChange = vi.fn();
    const onBackgroundChange = vi.fn();
    const onEdgePathStyleChange = vi.fn();
    const onEdgeEffectChange = vi.fn();
    render(
      <AppearancePicker
        canvasTheme="eye-care"
        canvasBackground="dots"
        canvasEdgePathStyle="gentle"
        canvasEdgeEffect="meteor"
        placement="bottom"
        onThemeChange={onThemeChange}
        onBackgroundChange={onBackgroundChange}
        onEdgePathStyleChange={onEdgePathStyleChange}
        onEdgeEffectChange={onEdgeEffectChange}
      />,
    );
    await user.click(screen.getByRole('button', { name: '外观' }));
    const dialog = await screen.findByRole('dialog', { name: '主题、画布背景与连接线' });
    await waitFor(() => expect(dialog).toBeVisible());
    expect(dialog.closest('.ant-popover')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '护眼' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(within(dialog).getByRole('button', { name: '深色' }));
    expect(onThemeChange).toHaveBeenCalledWith('dark');
    await user.click(within(dialog).getByRole('tab', { name: '背景' }));
    await user.click(within(dialog).getByRole('button', { name: '十字' }));
    expect(onBackgroundChange).toHaveBeenCalledWith('cross');
    await user.click(within(dialog).getByRole('tab', { name: '连接' }));
    expect(within(dialog).getByRole('button', { name: /轻弧曲线/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(within(dialog).getByRole('button', { name: /直角折线/ }));
    expect(onEdgePathStyleChange).toHaveBeenCalledWith('step');
    await user.click(within(dialog).getByRole('button', { name: /无特效/ }));
    expect(onEdgeEffectChange).toHaveBeenCalledWith('none');
    expect(
      within(dialog).getByRole('group', { name: '连接线组合预览' }).querySelector('svg path'),
    ).toHaveAttribute('d');
    expect(onThemeChange).toHaveBeenCalledTimes(1);
    expect(onBackgroundChange).toHaveBeenCalledTimes(1);
  });

  it('悬停展开、Escape/外部点击关闭，不触发任何设置变更', async () => {
    const user = userEvent.setup();
    const onThemeChange = vi.fn();
    const onBackgroundChange = vi.fn();
    render(
      <AppearancePicker
        canvasTheme="light"
        canvasBackground="blank"
        placement="top"
        compact
        onThemeChange={onThemeChange}
        onBackgroundChange={onBackgroundChange}
      />,
    );
    const trigger = screen.getByRole('button', { name: '外观' });
    await user.hover(trigger);
    await waitFor(() => expect(screen.getByRole('dialog')).toBeVisible());
    await user.keyboard('{Escape}');
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
    await user.click(trigger);
    await waitFor(() => expect(screen.getByRole('dialog')).toBeVisible());
    await user.click(document.body);
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
    expect(onThemeChange).not.toHaveBeenCalled();
    expect(onBackgroundChange).not.toHaveBeenCalled();
  });

  it('模态中不把外观浮层挂到外层 body', async () => {
    const user = userEvent.setup();
    render(
      <div role="dialog" aria-label="画布设置">
        <AppearancePicker
          canvasTheme="light"
          canvasBackground="dots"
          placement="bottom"
          onThemeChange={vi.fn()}
          onBackgroundChange={vi.fn()}
        />
      </div>,
    );
    const dialog = screen.getByRole('dialog', { name: '画布设置' });
    await user.click(within(dialog).getByRole('button', { name: '外观' }));
    expect(
      await within(dialog).findByRole('dialog', { name: '主题、画布背景与连接线' }),
    ).toBeInTheDocument();
  });
});
