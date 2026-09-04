import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TextPromptEditor } from './TextPromptEditor';

describe('TextPromptEditor', () => {
  afterEach(cleanup);

  it('preserves a composition draft across a stale parent render and commits once', () => {
    const onChange = vi.fn();
    const view = render(
      <TextPromptEditor
        nodeId="node-text"
        value="English prompt"
        placeholder="输入提示词"
        onChange={onChange}
      />,
    );
    const editor = screen.getByRole('textbox');

    fireEvent.compositionStart(editor);
    fireEvent.change(editor, { target: { value: 'zhong wen' } });
    view.rerender(
      <TextPromptEditor
        nodeId="node-text"
        value="English prompt"
        placeholder="输入提示词"
        onChange={onChange}
      />,
    );

    expect(editor).toHaveValue('zhong wen');
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.compositionEnd(editor, { target: { value: '中文提示词' } });
    fireEvent.change(editor, { target: { value: '中文提示词' } });

    expect(editor).toHaveValue('中文提示词');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('中文提示词');
  });

  it('commits ordinary English input immediately', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TextPromptEditor nodeId="node-text" value="" placeholder="输入提示词" onChange={onChange} />,
    );
    const editor = screen.getByRole('textbox');

    await user.type(editor, 'Product shot 2026!');

    expect(editor).toHaveValue('Product shot 2026!');
    expect(onChange).toHaveBeenLastCalledWith('Product shot 2026!');
  });

  it('切换节点后将提示词字段滚动到可见区域', () => {
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLTextAreaElement.prototype.scrollIntoView;
    Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    const view = render(
      <TextPromptEditor nodeId="node-one" value="" placeholder="输入提示词" onChange={vi.fn()} />,
    );

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'smooth' });
    scrollIntoView.mockClear();
    view.rerender(
      <TextPromptEditor nodeId="node-two" value="" placeholder="输入提示词" onChange={vi.fn()} />,
    );

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'smooth' });
    Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: originalScrollIntoView,
    });
  });
});
