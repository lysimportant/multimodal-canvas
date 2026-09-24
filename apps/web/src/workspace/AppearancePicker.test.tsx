import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppearancePicker } from './AppearancePicker';

afterEach(cleanup);

describe('AppearancePicker', () => {
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
