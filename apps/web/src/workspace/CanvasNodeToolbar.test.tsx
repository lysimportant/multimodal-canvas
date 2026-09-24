import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CanvasNodeToolbar } from './CanvasNodeToolbar';

afterEach(cleanup);

describe('CanvasNodeToolbar', () => {
  it('媒体创建按钮保留媒体类型契约和原生 button 语义', async () => {
    const onAddGenerateNode = vi.fn();
    render(<CanvasNodeToolbar onAddGenerateNode={onAddGenerateNode} />);
    for (const [mediaType, label] of [
      ['text', '文字'],
      ['image', '图片'],
      ['audio', '音频'],
      ['video', '视频'],
    ]) {
      const button = screen.getByRole('button', { name: `新建${label}生成节点` });
      expect(button).toHaveAttribute('type', 'button');
      expect(button).toHaveClass('ant-btn');
      await userEvent.click(button);
      expect(onAddGenerateNode).toHaveBeenLastCalledWith(mediaType);
    }
    expect(onAddGenerateNode).toHaveBeenCalledTimes(4);
  });

  it('系统按钮不把点击或指针按下传给画布，禁用撤销不会执行', async () => {
    const parentClick = vi.fn();
    const parentPointerDown = vi.fn();
    const onRequestUpload = vi.fn();
    const onUndoCanvas = vi.fn();
    const onFitView = vi.fn();
    render(
      <div onClick={parentClick} onPointerDown={parentPointerDown}>
        <CanvasNodeToolbar
          onAddGenerateNode={vi.fn()}
          onRequestUpload={onRequestUpload}
          onUndoCanvas={onUndoCanvas}
          canUndo={false}
          onFitView={onFitView}
        />
      </div>,
    );
    const upload = screen.getByRole('button', { name: '上传资产' });
    fireEvent.pointerDown(upload);
    await userEvent.click(upload);
    await userEvent.click(screen.getByRole('button', { name: '自动适配缩放' }));
    const undo = screen.getByRole('button', { name: '画布撤销' });
    expect(undo).toBeDisabled();
    await userEvent.click(undo);
    expect(onUndoCanvas).not.toHaveBeenCalled();
    expect(onRequestUpload).toHaveBeenCalledOnce();
    expect(onFitView).toHaveBeenCalledOnce();
    expect(parentClick).not.toHaveBeenCalled();
    expect(parentPointerDown).not.toHaveBeenCalled();
  });
});
