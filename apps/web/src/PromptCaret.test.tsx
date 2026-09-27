import '@testing-library/jest-dom/vitest';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PromptCaret } from './PromptCaret';

/** 用真实原生选区验证增强光标，不替换输入及组合事件的行为。 */
function CaretHarness({
  value = '一行提示词',
  nodeEditor = true,
  disabled = false,
}: {
  value?: string;
  nodeEditor?: boolean;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  return (
    <div className={nodeEditor ? 'node-quick-editor' : ''}>
      <div className="resource-mention-composer">
        <textarea ref={inputRef} aria-label="提示词" defaultValue={value} disabled={disabled} />
        <PromptCaret inputRef={inputRef} value={value} disabled={disabled} />
      </div>
    </div>
  );
}

/** jsdom 不排版：只模拟几何量，焦点、选区和事件仍使用浏览器接口。 */
function mockLayout(input: HTMLTextAreaElement, scale = 1) {
  Object.defineProperties(input, {
    offsetWidth: { configurable: true, value: 300 },
    offsetHeight: { configurable: true, value: 100 },
    clientWidth: { configurable: true, value: 298 },
    clientHeight: { configurable: true, value: 98 },
  });
  vi.spyOn(input, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, 0, 300 * scale, 100 * scale),
  );
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
    return (this.parentElement?.className === 'resource-mention-caret-mirror'
      ? [new DOMRect(30 * scale, 20 * scale, 0, 18 * scale)]
      : []) as unknown as DOMRectList;
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PromptCaret', () => {
  it('仅聚焦节点输入框时覆盖原生光标，失焦后恢复', () => {
    const { container } = render(<CaretHarness />);
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    const caret = container.querySelector('.resource-mention-caret')!;
    mockLayout(input);
    expect(caret).not.toBeVisible();
    act(() => input.focus());
    expect(caret).toBeVisible();
    expect(caret).toHaveStyle({ width: '2px', left: '30px', top: '20px', height: '18px' });
    expect(input).toHaveAttribute('data-prompt-caret', 'visible');
    act(() => input.blur());
    expect(caret).not.toBeVisible();
    expect(input).not.toHaveAttribute('data-prompt-caret');
  });

  it('不改变普通表单的光标与布局', () => {
    const { container } = render(<CaretHarness nodeEditor={false} />);
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    mockLayout(input);
    act(() => input.focus());
    expect(container.querySelector('.resource-mention-caret-mirror')).toBeNull();
    expect(input).not.toHaveAttribute('data-prompt-caret');
  });

  it('选择文字时不覆盖选区，选区收起后重新显示', () => {
    const { container } = render(<CaretHarness />);
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    mockLayout(input);
    act(() => input.focus());
    input.setSelectionRange(0, 2);
    fireEvent.select(input);
    expect(container.querySelector('.resource-mention-caret')).not.toBeVisible();
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(2);
    input.setSelectionRange(2, 2);
    fireEvent.select(input);
    expect(container.querySelector('.resource-mention-caret')).toBeVisible();
  });

  it('组合输入期间使用原生光标，提交后恢复且不篡改文字', () => {
    const { container } = render(<CaretHarness />);
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    mockLayout(input);
    act(() => input.focus());
    fireEvent.compositionStart(input);
    expect(input).not.toHaveAttribute('data-prompt-caret');
    fireEvent.input(input, { target: { value: '中文输入' } });
    expect(container.querySelector('.resource-mention-caret')).not.toBeVisible();
    fireEvent.compositionEnd(input, { data: '中文输入' });
    expect(container.querySelector('.resource-mention-caret')).toBeVisible();
    expect(input).toHaveValue('中文输入');
  });

  it('换行和 emoji 使用原生 UTF-16 范围，滚动同步位置并隐藏滚出区域的光标', () => {
    const { container } = render(<CaretHarness value={'提示😀\n下一行'} />);
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    mockLayout(input);
    act(() => input.focus());
    input.setSelectionRange(5, 5);
    fireEvent.select(input);
    expect(container.querySelector('.resource-mention-caret-mirror')).toHaveTextContent(
      '提示😀 下一行',
    );
    expect(container.querySelector('.resource-mention-caret-mirror > span')).toHaveTextContent(
      '下一行',
    );
    input.scrollTop = 10;
    input.scrollLeft = 5;
    fireEvent.scroll(input);
    expect(container.querySelector('.resource-mention-caret')).toHaveStyle({
      top: '10px',
      left: '25px',
    });
    input.scrollTop = 100;
    fireEvent.scroll(input);
    expect(container.querySelector('.resource-mention-caret')).not.toBeVisible();
  });

  it('画布缩放一半时保持两个屏幕像素宽，不放大文本或移动选区', () => {
    const { container } = render(<CaretHarness />);
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    mockLayout(input, 0.5);
    act(() => input.focus());
    expect(container.querySelector('.resource-mention-caret')).toHaveStyle({
      width: '4px',
      top: '20px',
      left: '30px',
    });
    expect(input).toHaveValue('一行提示词');
  });

  it('输入框禁用时立即移除增强光标', () => {
    const { container, rerender } = render(<CaretHarness />);
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    mockLayout(input);
    act(() => input.focus());
    expect(container.querySelector('.resource-mention-caret')).toBeVisible();
    rerender(<CaretHarness disabled />);
    expect(container.querySelector('.resource-mention-caret')).not.toBeVisible();
    expect(input).not.toHaveAttribute('data-prompt-caret');
  });

  it('卸载时清理测量层和原生光标标记', () => {
    const { container, unmount } = render(<CaretHarness />);
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    mockLayout(input);
    act(() => input.focus());
    unmount();
    expect(container.querySelector('.resource-mention-caret-mirror')).toBeNull();
    expect(input).not.toHaveAttribute('data-prompt-caret');
  });
});
