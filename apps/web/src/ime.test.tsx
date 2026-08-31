import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isImeKeyboardEvent, useImeDraft } from './ime';

function ImeInput({
  value,
  onCommit,
  onBlur,
  resetKey,
}: {
  value: string;
  onCommit: (value: string) => void;
  onBlur?: (value: string) => void;
  resetKey?: string | number;
}) {
  const { bind } = useImeDraft<HTMLInputElement>({ value, onCommit, onBlur, resetKey });
  return <input aria-label="IME input" {...bind} />;
}

function ImeTextarea({ value, onCommit }: { value: string; onCommit: (value: string) => void }) {
  const { bind } = useImeDraft<HTMLTextAreaElement>({ value, onCommit });
  return <textarea aria-label="IME textarea" {...bind} />;
}

describe('IME helpers', () => {
  afterEach(cleanup);

  it('keeps an input draft through stale external renders and commits composition once', () => {
    const onCommit = vi.fn();
    const view = render(<ImeInput value="English" onCommit={onCommit} />);
    const input = screen.getByRole('textbox', { name: 'IME input' });

    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: 'zhong' } });
    fireEvent.compositionUpdate(input, { target: { value: '中文' } });
    expect(input).toHaveValue('中文');
    expect(onCommit).not.toHaveBeenCalled();

    view.rerender(<ImeInput value="older external value" onCommit={onCommit} />);
    expect(input).toHaveValue('中文');

    fireEvent.compositionEnd(input, { target: { value: '中文' } });
    fireEvent.change(input, { target: { value: '中文' } });

    expect(input).toHaveValue('中文');
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('中文');
  });

  it('keeps an ordinary draft while older external values arrive out of order', () => {
    const onCommit = vi.fn();
    const view = render(<ImeInput value="initial" onCommit={onCommit} />);
    const input = screen.getByRole('textbox', { name: 'IME input' });

    fireEvent.change(input, { target: { value: 'draft one' } });
    fireEvent.change(input, { target: { value: 'draft two' } });
    expect(input).toHaveValue('draft two');
    expect(onCommit).toHaveBeenLastCalledWith('draft two');

    view.rerender(<ImeInput value="draft two" onCommit={onCommit} />);
    expect(input).toHaveValue('draft two');
    view.rerender(<ImeInput value="draft one" onCommit={onCommit} />);
    expect(input).toHaveValue('draft two');
    view.rerender(<ImeInput value="initial" onCommit={onCommit} />);
    expect(input).toHaveValue('draft two');
    view.rerender(<ImeInput value="authoritative external value" onCommit={onCommit} />);
    expect(input).toHaveValue('authoritative external value');
  });

  it('accepts an authoritative owner reset after a local draft', () => {
    const onCommit = vi.fn();
    const view = render(<ImeInput value="initial" resetKey={0} onCommit={onCommit} />);
    const input = screen.getByRole('textbox', { name: 'IME input' });

    fireEvent.change(input, { target: { value: 'dirty draft' } });
    expect(input).toHaveValue('dirty draft');

    view.rerender(<ImeInput value="" resetKey={1} onCommit={onCommit} />);
    expect(input).toHaveValue('');
  });

  it('commits an unfinished composition on blur without duplicating the final value', () => {
    const onCommit = vi.fn();
    const onBlur = vi.fn();
    render(<ImeInput value="" onCommit={onCommit} onBlur={onBlur} />);
    const input = screen.getByRole('textbox', { name: 'IME input' });

    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: '拼音' } });
    fireEvent.blur(input);
    fireEvent.compositionEnd(input, { target: { value: '拼音' } });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('拼音');
    expect(onBlur).toHaveBeenCalledWith('拼音');
  });

  it('keeps ordinary textarea typing, symbols, paste, and deletion immediate', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<ImeTextarea value="" onCommit={onCommit} />);
    const textarea = screen.getByRole('textbox', { name: 'IME textarea' });

    await user.type(textarea, 'Hello 123!?');
    await user.paste(' pasted');
    await user.keyboard('{Backspace}');

    expect(textarea).toHaveValue('Hello 123!? paste');
    expect(onCommit).toHaveBeenLastCalledWith('Hello 123!? paste');

    await user.clear(textarea);
    expect(textarea).toHaveValue('');
    expect(onCommit).toHaveBeenLastCalledWith('');
  });

  it('recognizes native, synthetic, and legacy IME keyboard markers', () => {
    expect(isImeKeyboardEvent({ isComposing: true })).toBe(true);
    expect(isImeKeyboardEvent({ keyCode: 229 })).toBe(true);
    expect(isImeKeyboardEvent({ nativeEvent: { isComposing: true } })).toBe(true);
    expect(isImeKeyboardEvent({ nativeEvent: { keyCode: 229 } })).toBe(true);
    expect(isImeKeyboardEvent({ keyCode: 13 })).toBe(false);
  });
});
