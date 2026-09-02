import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CompactSelect, type CompactSelectOption } from './CompactSelect';

const options: CompactSelectOption[] = [
  { value: 'low', label: '轻度' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '极高' },
  { value: 'max', label: '最高' },
  { value: 'ultra', label: 'Ultra' },
];

afterEach(cleanup);

describe('CompactSelect', () => {
  it('使用紧凑 combobox 展开垂直 listbox，并回传选择值', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<CompactSelect label="推理强度" value="max" options={options} onChange={onChange} />);

    const trigger = screen.getByRole('combobox', { name: '推理强度：最高' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await user.click(trigger);

    const listbox = screen.getByRole('listbox', { name: '推理强度选项' });
    expect(listbox).toBeVisible();
    expect(within(listbox).getAllByRole('option')).toHaveLength(6);
    expect(within(listbox).getByRole('option', { name: '最高', selected: true })).toBeVisible();

    await user.click(within(listbox).getByRole('option', { name: 'Ultra' }));
    expect(onChange).toHaveBeenCalledWith('ultra');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('支持方向键确认、Escape 和点击外部关闭', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <div>
        <CompactSelect label="推理强度" options={options} onChange={onChange} />
        <button type="button">外部按钮</button>
      </div>,
    );

    const trigger = screen.getByRole('combobox', { name: '推理强度：未设置' });
    await user.click(trigger);
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenCalledWith('high');

    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard('{Escape}');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await user.click(trigger);
    fireEvent.pointerDown(screen.getByRole('button', { name: '外部按钮' }));
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('悬停时可展开并跳过禁用项', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <CompactSelect
        label="模型"
        options={[
          { value: 'unavailable', label: '不可用', disabled: true },
          { value: 'available', label: '可用' },
        ]}
        onChange={onChange}
        openOnHover
      />,
    );

    const root = screen.getByText('模型').parentElement as HTMLElement;
    await user.hover(root);
    expect(screen.getByRole('option', { name: '不可用' })).toBeDisabled();
    expect(screen.getByRole('option', { name: '可用', selected: true })).toBeInTheDocument();
  });
});
