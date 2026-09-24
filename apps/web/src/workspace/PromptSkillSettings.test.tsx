import '@testing-library/jest-dom/vitest';

import { Button, Input } from '@multimodal-canvas/ui';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CompactSelect } from './CompactSelect';
import { PromptSkillSettings } from './PromptSkillSettings';

afterEach(cleanup);

describe('PromptSkillSettings', () => {
  it('悬停不抢走原焦点，点击固定，退出不触发优化操作', async () => {
    const user = userEvent.setup();
    const optimize = vi.fn();
    render(
      <>
        <Input aria-label="原提示词" />
        <PromptSkillSettings selected>
          <Button onClick={optimize}>优化提示词</Button>
        </PromptSkillSettings>
      </>,
    );
    const input = screen.getByRole('textbox', { name: '原提示词' });
    await user.click(input);
    const trigger = screen.getByRole('button', { name: 'Skill 配置' });
    expect(trigger).toHaveAttribute('data-selected', 'true');
    await user.hover(trigger);
    await waitFor(() => expect(screen.getByRole('group', { name: 'Skill 配置' })).toBeVisible());
    expect(input).toHaveFocus();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
    expect(input).toHaveFocus();
    await user.unhover(trigger);
    await user.hover(trigger);
    await user.click(trigger);
    await user.unhover(trigger);
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await user.click(trigger);
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
    expect(optimize).not.toHaveBeenCalled();
  });

  it('嵌套 Select 不误关闭配置，关闭重开保留父层选择与预览', async () => {
    const user = userEvent.setup();
    const optimize = vi.fn();
    /** 模拟实际优化会话：选择和预览由浮层外的父组件持有。 */
    function Session() {
      const [value, setValue] = useState('a');
      return (
        <div role="dialog" aria-label="节点编辑">
          <PromptSkillSettings selected>
            <CompactSelect
              label="模型"
              value={value}
              options={[
                { value: 'a', label: '文字 A' },
                { value: 'b', label: '文字 B' },
              ]}
              onChange={setValue}
            />
            <Button onClick={optimize}>优化提示词</Button>
          </PromptSkillSettings>
          <Input aria-label="优化预览" defaultValue="已编辑的预览" />
        </div>
      );
    }
    render(<Session />);
    const trigger = screen.getByRole('button', { name: 'Skill 配置' });
    await user.click(trigger);
    await user.click(screen.getByRole('combobox'));
    const option = await screen.findByRole('option', { name: '文字 B' });
    expect(option.closest('[role="dialog"]')).toHaveAccessibleName('Skill 设置浮层');
    await user.click(option);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('combobox')).toHaveAccessibleName('模型：文字 B');
    await user.click(screen.getByRole('textbox', { name: '优化预览' }));
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
    expect(screen.getByRole('textbox', { name: '优化预览' })).toHaveValue('已编辑的预览');
    await user.click(trigger);
    expect(screen.getByRole('combobox')).toHaveAccessibleName('模型：文字 B');
    expect(optimize).not.toHaveBeenCalled();
  });

  it('编辑器阻止指针冒泡时，真实 Popover 仍识别外部点击', async () => {
    const user = userEvent.setup();
    render(
      <section onPointerDown={(event) => event.stopPropagation()}>
        <PromptSkillSettings selected={false}>
          <Button>优化提示词</Button>
        </PromptSkillSettings>
        <div data-testid="blank" />
      </section>,
    );
    const trigger = screen.getByRole('button', { name: 'Skill 配置' });
    await user.click(trigger);
    await waitFor(() => expect(screen.getByRole('group', { name: 'Skill 配置' })).toBeVisible());
    await user.click(screen.getByTestId('blank'));
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
  });
});
