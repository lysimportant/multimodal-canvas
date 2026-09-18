import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SettingsSourceSummary } from './workspace/settings-components';

afterEach(cleanup);

describe('SettingsSourceSummary', () => {
  it('通过 hover 与键盘 focus 显示可访问的解析顺序提示', async () => {
    const user = userEvent.setup();
    const onParentKeyDown = vi.fn();
    render(
      <div onKeyDown={onParentKeyDown}>
        <SettingsSourceSummary
          sourceLabel="继承自全局"
          hint="本次运行显式配置 > 单节点显式配置 > 项目类型默认 > 【全局类型默认】"
        />
        <button type="button">下一项</button>
      </div>,
    );

    const trigger = screen.getByRole('button', { name: '查看模型来源解析顺序' });
    const tooltip = screen.getByRole('tooltip', { hidden: true });
    expect(trigger).toHaveAttribute('aria-describedby', tooltip.id);
    expect(tooltip).toHaveTextContent(
      '本次运行显式配置 > 单节点显式配置 > 项目类型默认 > 【全局类型默认】',
    );
    expect(tooltip).not.toBeVisible();

    await user.hover(trigger);
    expect(tooltip).toBeVisible();
    await user.keyboard('{Escape}');
    expect(tooltip).not.toBeVisible();
    await user.unhover(trigger);
    await user.hover(trigger);
    expect(tooltip).toBeVisible();
    await user.unhover(trigger);
    expect(tooltip).not.toBeVisible();

    await user.tab();
    expect(trigger).toHaveFocus();
    expect(tooltip).toBeVisible();
    onParentKeyDown.mockClear();
    await user.keyboard('{Escape}');
    expect(onParentKeyDown).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();
    expect(tooltip).not.toBeVisible();
    await user.tab();
    expect(screen.getByRole('button', { name: '下一项' })).toHaveFocus();
    expect(tooltip).not.toBeVisible();
  });

  it.each([
    ['credential-missing', '已失效：引用的 Key 已被删除，请重新选择连接'],
    ['model-missing', '已失效：模型不在该 Key 的模型目录中'],
  ])('保持来源、Key 摘要和 %s 错误常驻可见', (invalidReason, errorMessage) => {
    const credentialLabel =
      'https://independent.example.com/a/very/long/provider/path/v1 · sha256:independent';
    render(
      <SettingsSourceSummary
        sourceLabel="节点独立"
        hint="本次运行显式配置 > 【单节点显式配置】 > 项目类型默认 > 全局类型默认"
        credentialLabel={credentialLabel}
        invalidReason={invalidReason}
      />,
    );

    const source = screen.getByText('节点独立');
    const credential = screen.getByText(credentialLabel);
    const error = screen.getByRole('alert');
    expect(source).toBeVisible();
    expect(credential).toBeVisible();
    expect(credential).toHaveAttribute('title', credentialLabel);
    expect(error).toBeVisible();
    expect(error).toHaveTextContent(errorMessage);
    expect(source.closest('[role="tooltip"]')).toBeNull();
    expect(credential.closest('[role="tooltip"]')).toBeNull();
    expect(error.closest('[role="tooltip"]')).toBeNull();
    expect(screen.getByRole('tooltip', { hidden: true })).not.toBeVisible();
  });
});
