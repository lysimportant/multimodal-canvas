import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
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
  it('选中项的 Key 尾号独立展示，模型名称截断不影响连接识别', () => {
    render(
      <CompactSelect
        label="模型"
        value="one"
        options={[
          {
            value: 'one',
            label: '同名模型',
            description: 'example.test · Key …test0008',
            trailingLabel: 'Key …test0008',
          },
        ]}
        onChange={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('combobox', { name: '模型：同名模型 · Key …test0008' }),
    ).toHaveAttribute('title', '同名模型 · example.test · Key …test0008');
    expect(screen.getByText('Key …test0008', { exact: true })).toHaveClass(
      'compact-select-trigger-source',
    );
  });
  it('分类选项的用途仅在悬停或键盘焦点时显示，Escape 关闭提示', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <CompactSelect
        label="Skill"
        options={[
          {
            value: 'character',
            label: '人物',
            groupLabel: '人物与场景',
            tooltip: '描述人物外观和服装',
          },
          { value: 'scene', label: '场景', groupLabel: '人物与场景', tooltip: '描述空间布局' },
          { value: 'story', label: '小说', groupLabel: '文字创作', tooltip: '组织叙事结构' },
        ]}
        onChange={onChange}
      />,
    );
    const trigger = screen.getByRole('combobox');
    await user.click(trigger);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(screen.getAllByText('人物与场景')).toHaveLength(1);
    expect(screen.getByText('文字创作')).toBeVisible();
    const character = screen.getByRole('option', { name: '人物' });
    await user.hover(character);
    expect(screen.getByRole('tooltip')).toHaveTextContent('描述人物外观和服装');
    expect(character).toHaveAccessibleDescription('描述人物外观和服装');
    const tooltip = screen.getByRole('tooltip');
    fireEvent.mouseOut(character, { relatedTarget: tooltip });
    fireEvent.mouseOver(tooltip, { relatedTarget: character });
    expect(screen.getByRole('tooltip')).toHaveTextContent('描述人物外观和服装');
    fireEvent.mouseOut(tooltip, { relatedTarget: null });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    trigger.focus();
    await user.keyboard('{End}');
    expect(screen.getByRole('tooltip')).toHaveTextContent('组织叙事结构');
    expect(trigger).toHaveAccessibleDescription('组织叙事结构');
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith('story');
    await user.click(trigger);
    fireEvent.focus(character);
    expect(screen.getByRole('tooltip')).toHaveTextContent('描述人物外观和服装');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('悬停菜单延时关闭，点击固定后移出保持展开', async () => {
    const user = userEvent.setup();
    render(<CompactSelect label="档位" options={options} onChange={vi.fn()} openOnHover />);
    const trigger = screen.getByRole('combobox');
    await user.hover(trigger);
    await user.unhover(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
    await user.hover(trigger);
    await user.keyboard('{Escape}');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await user.unhover(trigger);
    await user.hover(trigger);
    await user.click(trigger);
    await user.unhover(trigger);
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard('{Escape}');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

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
