import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AssetFlowNode } from '../canvas-utils';
import { NodeQuickEditor, type NodeQuickEditorProps } from './NodeQuickEditor';

const imageNode = {
  id: 'node_image',
  type: 'image',
  position: { x: 0, y: 0 },
  data: {
    label: '产品主图',
    mediaType: 'image',
    mode: 'generate',
    enabled: true,
    prompt: '白色背景',
    modelAlias: 'removed-image-model',
    inferenceStrength: 'high',
  },
} as AssetFlowNode;

const models: NodeQuickEditorProps['models'] = [
  { id: 'text-model', name: '文字模型', mediaTypes: ['text'] },
  { id: 'image-model', name: '图片模型', mediaTypes: ['image'] },
  { id: 'multi-model', name: '多模态模型', mediaTypes: ['text', 'image'] },
];

function makeProps(overrides: Partial<NodeQuickEditorProps> = {}): NodeQuickEditorProps {
  return {
    node: imageNode,
    models,
    busy: false,
    onPromptChange: vi.fn(),
    onModelChange: vi.fn(),
    onInferenceStrengthChange: vi.fn(),
    onRun: vi.fn(),
    ...overrides,
  };
}

afterEach(cleanup);

describe('NodeQuickEditor', () => {
  it('只列出当前媒体模型，并保留目录中缺失的当前覆盖值', () => {
    render(<NodeQuickEditor {...makeProps()} />);

    expect(screen.getByText('生成设置 · 图片')).toBeVisible();
    expect(screen.getByText('产品主图')).toBeVisible();

    const modelSelect = screen.getByRole('combobox', { name: '模型' });
    expect(modelSelect).toHaveValue('removed-image-model');
    expect(screen.getByRole('option', { name: '继承项目默认模型' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '图片模型' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '多模态模型' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '文字模型' })).not.toBeInTheDocument();
    expect(
      screen.getByRole('option', {
        name: 'removed-image-model（当前设置，目录中不可用）',
      }),
    ).toBeInTheDocument();
  });

  it('回传提示词、模型、推理强度和生成操作，并阻止指针事件传给画布', async () => {
    const user = userEvent.setup();
    const props = makeProps();
    const onCanvasPointerDown = vi.fn();
    render(
      <div onPointerDown={onCanvasPointerDown}>
        <NodeQuickEditor {...props} />
      </div>,
    );

    const prompt = screen.getByRole('textbox', { name: '提示词' });
    fireEvent.change(prompt, { target: { value: '柔和棚拍光' } });
    await user.selectOptions(screen.getByRole('combobox', { name: '模型' }), 'image-model');
    await user.selectOptions(screen.getByRole('combobox', { name: '推理强度' }), 'low');
    await user.click(screen.getByRole('button', { name: '生成' }));
    fireEvent.pointerDown(prompt);

    expect(props.onPromptChange).toHaveBeenCalledWith('柔和棚拍光');
    expect(props.onModelChange).toHaveBeenCalledWith('image-model');
    expect(props.onInferenceStrengthChange).toHaveBeenCalledWith('low');
    expect(props.onRun).toHaveBeenCalledTimes(1);
    expect(onCanvasPointerDown).not.toHaveBeenCalled();
    expect(screen.getByLabelText('产品主图生成设置')).toHaveClass('nodrag', 'nowheel', 'nopan');
  });

  it('节点停用或忙碌时禁用生成按钮', () => {
    const { rerender } = render(
      <NodeQuickEditor
        {...makeProps({
          node: { ...imageNode, data: { ...imageNode.data, enabled: false } },
        })}
      />,
    );

    expect(screen.getByRole('button', { name: '生成' })).toBeDisabled();

    rerender(<NodeQuickEditor {...makeProps({ busy: true })} />);
    expect(screen.getByRole('button', { name: '生成中' })).toBeDisabled();
  });
});
