import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FilePicker, type FilePickerHandle } from './file-picker';

afterEach(cleanup);

describe('Ant Design file picker', () => {
  it('delivers each selection once and leaves uploads to the caller', async () => {
    const selected = vi.fn();
    const request = vi.spyOn(XMLHttpRequest.prototype, 'open');
    const files = [
      new File(['one'], 'one.txt', { type: 'text/plain' }),
      new File(['two'], 'two.txt', { type: 'text/plain' }),
    ];
    render(<FilePicker aria-label="选择文件" multiple onFilesSelected={selected} />);
    expect(document.querySelector('.ant-upload')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('选择文件'), { target: { files } });
    await waitFor(() => expect(selected).toHaveBeenCalledExactlyOnceWith(files));
    expect(document.querySelector('.ant-upload-list')).not.toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
    request.mockRestore();
  });

  it('opens the current input after a selection and allows the same file again', async () => {
    const ref = createRef<FilePickerHandle>();
    const selected = vi.fn();
    const file = new File(['one'], 'one.txt', { type: 'text/plain' });
    render(<FilePicker ref={ref} aria-label="选择文件" onFilesSelected={selected} />);
    const original = screen.getByLabelText('选择文件');
    fireEvent.change(original, { target: { files: [file] } });
    await waitFor(() => expect(selected).toHaveBeenCalledTimes(1));
    const current = screen.getByLabelText('选择文件');
    const click = vi.spyOn(current, 'click').mockImplementation(() => {});
    ref.current?.click();
    expect(click).toHaveBeenCalledOnce();
    fireEvent.change(current, { target: { files: [file] } });
    await waitFor(() => expect(selected).toHaveBeenCalledTimes(2));
  });

  it('respects disabled state and file selection constraints', () => {
    const ref = createRef<FilePickerHandle>();
    render(
      <FilePicker
        ref={ref}
        aria-label="选择图片"
        accept="image/*"
        disabled
        onFilesSelected={vi.fn()}
      />,
    );
    const input = screen.getByLabelText('选择图片');
    const click = vi.spyOn(input, 'click').mockImplementation(() => {});
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute('accept', 'image/*');
    expect(input).not.toHaveAttribute('multiple');
    ref.current?.click();
    expect(click).not.toHaveBeenCalled();
  });
});
