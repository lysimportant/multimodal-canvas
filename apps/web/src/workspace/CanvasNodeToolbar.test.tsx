import '@testing-library/jest-dom/vitest';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

  it('短视频复刻只显示图标并保留可访问名称和提示', () => {
    render(<CanvasNodeToolbar onAddGenerateNode={vi.fn()} onOpenVideoRecreation={vi.fn()} />);
    const button = screen.getByRole('button', { name: '短视频复刻' });
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveClass(
      'canvas-node-tool',
      'canvas-node-action-tool',
      'canvas-video-recreation-tool',
    );
    expect(button).toHaveAttribute('title', '短视频复刻：查看使用流程并选择原视频');
    expect(button).toHaveAccessibleName('短视频复刻');
    expect(button.textContent).toBe('');
    const icon = button.querySelector('svg.lucide-clapperboard');
    expect(icon).toHaveAttribute('width', '16');
    expect(icon).toHaveAttribute('height', '16');
    expect(icon).toHaveAttribute('aria-hidden', 'true');
  });

  it('短视频复刻只打开流程，不创建媒体节点或把点击和指针按下传给画布', async () => {
    const user = userEvent.setup();
    const onOpenVideoRecreation = vi.fn();
    const onAddGenerateNode = vi.fn();
    const parentClick = vi.fn();
    const parentPointerDown = vi.fn();
    render(
      <div onClick={parentClick} onPointerDown={parentPointerDown}>
        <CanvasNodeToolbar
          onAddGenerateNode={onAddGenerateNode}
          onOpenVideoRecreation={onOpenVideoRecreation}
        />
      </div>,
    );
    const button = screen.getByRole('button', { name: '短视频复刻' });
    fireEvent.pointerDown(button);
    await user.click(button);
    expect(onOpenVideoRecreation).toHaveBeenCalledOnce();
    expect(onAddGenerateNode).not.toHaveBeenCalled();
    expect(parentClick).not.toHaveBeenCalled();
    expect(parentPointerDown).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'Enter', key: '{Enter}' },
    { label: 'Space', key: ' ' },
  ])('短视频复刻可通过 Tab 聚焦并用 $label 打开流程', async ({ key }) => {
    const user = userEvent.setup();
    const onOpenVideoRecreation = vi.fn();
    const onAddGenerateNode = vi.fn();
    const parentClick = vi.fn();
    render(
      <div onClick={parentClick}>
        <CanvasNodeToolbar
          onAddGenerateNode={onAddGenerateNode}
          onOpenVideoRecreation={onOpenVideoRecreation}
        />
      </div>,
    );
    for (const name of [
      '新建文字生成节点',
      '新建图片生成节点',
      '新建音频生成节点',
      '新建视频生成节点',
      '短视频复刻',
    ]) {
      await user.tab();
      expect(screen.getByRole('button', { name })).toHaveFocus();
    }
    expect(onOpenVideoRecreation).not.toHaveBeenCalled();
    await user.keyboard(key);
    expect(onOpenVideoRecreation).toHaveBeenCalledOnce();
    expect(onAddGenerateNode).not.toHaveBeenCalled();
    expect(parentClick).not.toHaveBeenCalled();
  });

  it('短视频复刻复用胶囊按钮样式及 hover/focus 提示，不单独覆盖宽度和颜色', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8').replace(/\s+/g, ' ');
    const launcherCss = readFileSync(
      resolve(process.cwd(), 'src/workspace/VideoRecreationLauncher.css'),
      'utf8',
    );
    expect(launcherCss).not.toContain('.canvas-video-recreation-tool');
    expect(css).toMatch(/\.canvas-node-tool::after \{[^}]*content: attr\(aria-label\);/);
    expect(css).toMatch(/\.canvas-node-tool:hover::after,[^{]*\{[^}]*opacity: 1;/);
    expect(css).toMatch(/\.canvas-node-tool:focus-visible::after \{[^}]*opacity: 1;/);
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

  it('CSS 保证节点被拖到底部时不盖住胶囊，胶囊仍低于快速编辑器浮层', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8').replace(/\s+/g, ' ');
    // React Flow 根元素的层叠上下文已被解除，节点视口与胶囊同处一个上下文，
    // 因此两者的 z-index 可以直接比较。
    const capsuleLevel = Number(css.match(/\.canvas-node-tools \{[^}]*z-index: (\d+);/)?.[1]);
    const nodeLevel = Number(
      css.match(/\.canvas-area \.react-flow__viewport \{[^}]*z-index: (\d+);/)?.[1],
    );
    const quickEditorLevel = Number(
      css.match(/\.quick-editor-overlay \{[^}]*z-index: (\d+);/)?.[1],
    );
    expect(capsuleLevel).toBeGreaterThan(nodeLevel);
    expect(capsuleLevel).toBeLessThan(quickEditorLevel);
  });
});
