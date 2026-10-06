import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  INLINE_REFERENCE,
  InlinePromptInput,
  readInlinePrompt,
  selectInlinePrompt,
  type InlinePromptAtom,
} from './InlinePromptInput';

afterEach(cleanup);

/** 创建确定身份与模型位置的测试原子，预览文字不会计入正文。 */
function atom(id: string, start: number): InlinePromptAtom {
  return {
    id,
    start,
    label: id,
    content: <span data-testid={`atom-${id}`}>{id}</span>,
  };
}

describe('InlinePromptInput', () => {
  it('按一个 U+FFFC 位置读取内联原子，并保留普通文字和换行', () => {
    const root = document.createElement('div');
    root.innerHTML = '<div>前<br>后</div>';
    const inline = document.createElement('span');
    inline.setAttribute('data-inline-reference', 'asset-1');
    root.firstElementChild!.insertBefore(inline, root.firstElementChild!.lastChild);

    expect(readInlinePrompt(root)).toBe(`前\n${INLINE_REFERENCE}后`);
  });

  it('把模型位置映射到原生选区，并避免把光标放进原子内部', () => {
    const root = document.createElement('div');
    const before = document.createTextNode('前');
    const inline = document.createElement('span');
    inline.setAttribute('data-inline-reference', 'asset-1');
    inline.textContent = '缩略图';
    const after = document.createTextNode('后');
    root.append(before, inline, after);
    document.body.append(root);

    selectInlinePrompt(root, 1);
    let selection = document.getSelection()!;
    expect(selection.anchorNode?.textContent).toBe('前');
    expect(selection.anchorOffset).toBe(1);
    expect(selection.isCollapsed).toBe(true);

    selectInlinePrompt(root, 1, 2);
    selection = document.getSelection()!;
    expect(selection.anchorNode?.textContent).toBe('前');
    expect(selection.anchorOffset).toBe(1);
    expect(selection.focusNode).toBe(root);
    expect(selection.focusOffset).toBe(2);
    root.remove();
  });

  it('首次插入原子后切换到 contentEditable，并向父层报告原子身份', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <InlinePromptInput
        value="前"
        atoms={[]}
        onChange={onChange}
        onSelect={vi.fn()}
        onKeyDown={vi.fn()}
        onKeyUp={vi.fn()}
        ariaLabel="提示词"
      />,
    );

    const textarea = screen.getByRole('textbox', { name: '提示词' });
    expect(textarea.tagName).toBe('TEXTAREA');
    rerender(
      <InlinePromptInput
        value={`前${INLINE_REFERENCE}后`}
        atoms={[atom('asset-1', 1)]}
        onChange={onChange}
        onSelect={vi.fn()}
        onKeyDown={vi.fn()}
        onKeyUp={vi.fn()}
        ariaLabel="提示词"
      />,
    );

    const rich = screen.getByRole('textbox', { name: '提示词' });
    expect(rich).toHaveAttribute('contenteditable', 'true');
    expect(rich.querySelector('[data-inline-reference="asset-1"]')).toBeInTheDocument();
    expect(readInlinePrompt(rich)).toBe(`前${INLINE_REFERENCE}后`);

    const textNode = Array.from(rich.childNodes).find(
      (node): node is Text => node.nodeType === Node.TEXT_NODE && node.textContent === '后',
    );
    expect(textNode).toBeDefined();
    textNode!.textContent = '后文';
    fireEvent.input(rich);
    expect(onChange).toHaveBeenLastCalledWith(
      `前${INLINE_REFERENCE}后文`,
      expect.any(Number),
      expect.any(Number),
      [{ id: 'asset-1', start: 1 }],
    );
  });

  it('富文本粘贴只插入纯文字，并去掉外部 U+FFFC 标记', () => {
    const onChange = vi.fn();
    render(
      <InlinePromptInput
        value={`前${INLINE_REFERENCE}后`}
        atoms={[atom('asset-1', 1)]}
        onChange={onChange}
        onSelect={vi.fn()}
        onKeyDown={vi.fn()}
        onKeyUp={vi.fn()}
        ariaLabel="提示词"
      />,
    );
    const rich = screen.getByRole('textbox', { name: '提示词' });
    selectInlinePrompt(rich, 2);
    const clipboardData = {
      getData: (type: string) => (type === 'text/plain' ? `新${INLINE_REFERENCE}字` : ''),
    };
    fireEvent.paste(rich, { clipboardData });

    expect(onChange).toHaveBeenLastCalledWith(`前${INLINE_REFERENCE}新字后`, 4, 4, [
      { id: 'asset-1', start: 1 },
    ]);
  });

  it('富文本组合输入期间保留草稿和引用身份，旧父值不覆盖正在输入的中文', () => {
    const onChange = vi.fn();
    const props = {
      value: `前${INLINE_REFERENCE}后`,
      atoms: [atom('asset-1', 1)],
      onChange,
      onSelect: vi.fn(),
      onKeyDown: vi.fn(),
      onKeyUp: vi.fn(),
      ariaLabel: '提示词',
    };
    const view = render(<InlinePromptInput {...props} />);
    const rich = screen.getByRole('textbox', { name: '提示词' });
    const tail = rich.lastChild!;

    fireEvent.compositionStart(rich);
    tail.textContent = '后zhong wen';
    fireEvent.input(rich);
    view.rerender(<InlinePromptInput {...props} atoms={[atom('asset-1', 1)]} />);

    expect(readInlinePrompt(rich)).toBe(`前${INLINE_REFERENCE}后zhong wen`);
    expect(onChange).not.toHaveBeenCalled();
    expect(rich.querySelector('[data-inline-reference="asset-1"]')).toBeInTheDocument();

    tail.textContent = '后中文';
    fireEvent.compositionEnd(rich);

    expect(readInlinePrompt(rich)).toBe(`前${INLINE_REFERENCE}后中文`);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(
      `前${INLINE_REFERENCE}后中文`,
      expect.any(Number),
      expect.any(Number),
      [{ id: 'asset-1', start: 1 }],
    );
  });
});
