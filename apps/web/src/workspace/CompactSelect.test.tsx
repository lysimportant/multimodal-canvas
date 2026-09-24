import '@testing-library/jest-dom/vitest';

import { Button, Dialog, DialogContent, DialogTitle } from '@multimodal-canvas/ui';
import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CompactSelect, type CompactSelectOption } from './CompactSelect';

/** 与运行参数一致的短枚举，顺序用于验证真实 Select 的导航。 */
const options: CompactSelectOption[] = [
  { value: 'low', label: '轻度' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '极高' },
  { value: 'max', label: '最高' },
  { value: 'ultra', label: 'Ultra' },
];

/** jsdom 不生成浏览器的 keyCode，补齐 Ant Design 使用的原生键盘字段。 */
function key(element: HTMLElement, name: string, code: number) {
  fireEvent.keyDown(element, { key: name, code: name, keyCode: code, which: code });
  fireEvent.keyUp(element, { key: name, code: name, keyCode: code, which: code });
}

afterEach(cleanup);

describe('CompactSelect', () => {
  it('选中项的 Key 尾号独立展示，名称与说明保留在真实 Select 上', () => {
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
    const trigger = screen.getByRole('combobox', { name: '模型：同名模型 · Key …test0008' });
    expect(trigger.closest('.ant-select')).toHaveAttribute(
      'title',
      '同名模型 · example.test · Key …test0008',
    );
    expect(screen.getByText('Key …test0008', { exact: true })).toHaveClass(
      'compact-select-trigger-source',
    );
  });

  it('保留分组和悬停/键盘用途提示，Escape 关闭且不修改值', async () => {
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
    await waitFor(() => expect(screen.getByRole('option', { name: '人物' })).toBeVisible());
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(screen.getAllByText('人物与场景')).toHaveLength(1);
    expect(screen.getByText('文字创作')).toBeVisible();
    const character = screen.getByRole('option', { name: '人物' });
    await user.hover(within(character).getByText('人物'));
    await waitFor(() =>
      expect(screen.getByRole('tooltip')).toHaveTextContent('描述人物外观和服装'),
    );
    expect(character).toHaveAccessibleDescription('描述人物外观和服装');
    await user.hover(screen.getByRole('tooltip'));
    expect(screen.getByRole('tooltip')).toHaveTextContent('描述人物外观和服装');
    await user.unhover(screen.getByRole('tooltip'));
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
    trigger.focus();
    key(trigger, 'ArrowDown', 40);
    key(trigger, 'ArrowDown', 40);
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent('组织叙事结构'));
    expect(trigger).toHaveAccessibleDescription('组织叙事结构');
    key(trigger, 'Enter', 13);
    expect(onChange).toHaveBeenCalledWith('story');
    await user.click(trigger);
    key(trigger, 'ArrowDown', 40);
    key(trigger, 'Escape', 27);
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument());
    expect(onChange).toHaveBeenCalledTimes(1);
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
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
    await user.unhover(trigger);
    await user.hover(trigger);
    await user.click(trigger);
    await user.unhover(trigger);
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    key(trigger, 'Escape', 27);
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
  });

  it('渲染全部真实 option 并回传确认值，不使用虚拟可访问节点', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<CompactSelect label="推理强度" value="max" options={options} onChange={onChange} />);
    const trigger = screen.getByRole('combobox', { name: '推理强度：最高' });
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
    await user.click(trigger);
    const listbox = await screen.findByRole('listbox', { name: '推理强度选项' });
    await waitFor(() => expect(listbox).toBeVisible());
    expect(within(listbox).getAllByRole('option')).toHaveLength(6);
    expect(within(listbox).getByRole('option', { name: '最高', selected: true })).toBeVisible();
    await user.click(within(listbox).getByRole('option', { name: 'Ultra' }));
    expect(onChange).toHaveBeenCalledWith('ultra');
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
  });

  it('支持方向键确认、Escape 和外部点击关闭', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <div>
        <CompactSelect label="推理强度" options={options} onChange={onChange} />
        <Button type="button">外部按钮</Button>
      </div>,
    );
    const trigger = screen.getByRole('combobox', { name: '推理强度：未设置' });
    await user.click(trigger);
    key(trigger, 'ArrowDown', 40);
    key(trigger, 'ArrowDown', 40);
    key(trigger, 'Enter', 13);
    expect(onChange).toHaveBeenCalledWith('high');
    await user.click(trigger);
    key(trigger, 'Escape', 27);
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: '外部按钮' }));
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
  });

  it('悬停展开保留禁用项，点击不提交，键盘只确认可用项', async () => {
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
    const trigger = screen.getByRole('combobox');
    await user.hover(trigger);
    const disabled = await screen.findByRole('option', { name: '不可用' });
    expect(disabled).toHaveAttribute('aria-disabled', 'true');
    await user.click(disabled);
    expect(onChange).not.toHaveBeenCalled();
    trigger.focus();
    key(trigger, 'ArrowDown', 40);
    key(trigger, 'Enter', 13);
    expect(onChange).toHaveBeenCalledWith('available');
  });

  it('模态内的浮层归属最近 Dialog，保留说明与短枚举多列布局', async () => {
    const user = userEvent.setup();
    render(
      <div role="dialog" aria-label="参数">
        <CompactSelect
          label="尺寸"
          value="square"
          optionLayout="grid"
          options={[
            { value: 'square', label: '1:1', description: '正方形' },
            { value: 'wide', label: '16:9', description: '宽屏' },
          ]}
          onChange={vi.fn()}
          floating
        />
      </div>,
    );
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('combobox'));
    const option = await within(dialog).findByRole('option', { name: '16:9' });
    expect(option).toHaveTextContent('宽屏');
    expect(option.closest('.compact-select-antd-grid')).toBeInTheDocument();
  });

  it('真实 Modal 中首次挂载和重开都为真实 listbox 命名，字段更名后同步更新', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onOpenChange = vi.fn();
    const renderDialog = (label: string) => (
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogTitle>完整编辑器</DialogTitle>
          <CompactSelect
            label={label}
            value="model-a"
            options={[
              {
                value: 'model-a',
                label: '模型 A',
                groupLabel: '来源 alpha',
                description: '当前可用',
              },
              { value: 'model-b', label: '模型 B', groupLabel: '来源 alpha', disabled: true },
            ]}
            onChange={onChange}
          />
        </DialogContent>
      </Dialog>
    );
    const view = render(renderDialog('模型'));
    const dialog = await screen.findByRole('dialog', { name: '完整编辑器' });
    const trigger = within(dialog).getByRole('combobox', { name: '模型：模型 A' });
    await waitFor(() => expect(trigger).toBeVisible());
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await user.click(trigger);
      const listbox = await within(dialog).findByRole('listbox', { name: '模型选项' });
      await waitFor(() => expect(listbox).toBeVisible());
      expect(listbox.closest('.ant-select-dropdown')).toBeInTheDocument();
      expect(trigger).toHaveAttribute('aria-controls', listbox.id);
      expect(within(listbox).getAllByRole('option')).toHaveLength(2);
      expect(within(listbox).getByRole('option', { name: '模型 B' })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
      const selected = within(listbox).getByRole('option', { name: '模型 A', selected: true });
      expect(selected).toHaveTextContent('当前可用');
      await user.click(selected);
      await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
    }
    expect(onChange).toHaveBeenNthCalledWith(1, 'model-a');
    expect(onChange).toHaveBeenNthCalledWith(2, 'model-a');
    await user.click(trigger);
    view.rerender(renderDialog('生成模型'));
    const renamedListbox = await within(dialog).findByRole('listbox', { name: '生成模型选项' });
    expect(trigger).toHaveAttribute('aria-controls', renamedListbox.id);
    expect(within(dialog).queryByRole('listbox', { name: '模型选项' })).not.toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('未知值不伪造已保存选择，无可用项时禁止打开', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const view = render(
      <CompactSelect label="模型" value="missing" options={options} onChange={onChange} />,
    );
    const trigger = screen.getByRole('combobox', { name: '模型：未设置' });
    await user.click(trigger);
    expect(screen.queryByRole('option', { selected: true })).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    view.rerender(
      <CompactSelect
        label="模型"
        options={[{ value: 'a', label: '停用', disabled: true }]}
        onChange={onChange}
      />,
    );
    expect(trigger).toBeDisabled();
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
  });
});
