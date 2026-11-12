import '@testing-library/jest-dom/vitest';

import { render } from '@testing-library/react';
import { targetPortRolesForMediaType, videoModes } from '@multimodal-canvas/domain';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@xyflow/react', () => {
  const Handle = ({
    type,
    position,
    id,
    isConnectable,
    ...props
  }: {
    type: string;
    position: string;
    id: string;
    isConnectable?: boolean;
    [key: string]: unknown;
  }) => (
    <button
      type="button"
      data-handle-type={type}
      data-position={position}
      data-handleid={id}
      data-connectable={isConnectable === false ? 'false' : 'true'}
      {...props}
    />
  );

  return {
    Handle,
    Position: { Top: 'top', Right: 'right', Bottom: 'bottom', Left: 'left' },
  };
});

import { getNodeHandleLayout, NodeHandles } from './NodeHandles';

describe('NodeHandles', () => {
  it('renders only a left input and a right output anchor', () => {
    const { container } = render(<NodeHandles mediaType="video" mode="generate" />);
    const visibleHandles = Array.from(container.querySelectorAll('.flow-node-handle'));

    expect(visibleHandles).toHaveLength(2);
    expect(visibleHandles.map((handle) => handle.getAttribute('data-handle-side')).sort()).toEqual([
      'left',
      'right',
    ]);
    expect(container.querySelector('[data-handle-side="left"]')).toHaveAttribute(
      'data-handle-type',
      'target',
    );
    expect(container.querySelector('[data-handle-side="right"]')).toHaveAttribute(
      'data-handle-type',
      'source',
    );
    expect(
      container.querySelectorAll('[data-position="top"], [data-position="bottom"]'),
    ).toHaveLength(0);
  });

  it('两个主连接点视觉透明但保留尺寸测量和连接命中区域', () => {
    const { container } = render(<NodeHandles mediaType="video" mode="generate" />);
    const handles = Array.from(container.querySelectorAll('.flow-node-handle')) as HTMLElement[];

    expect(handles).toHaveLength(2);
    for (const handle of handles) {
      expect(handle.style.opacity).toBe('0');
      expect(handle.style.display).toBe('');
      expect(handle.style.visibility).toBe('');
      expect(handle.style.pointerEvents).toBe('');
      expect(handle).toHaveAttribute('data-connectable', 'true');
    }
  });

  it('keeps every legacy target role measurable at the left input without accepting new connections', () => {
    const { container } = render(<NodeHandles mediaType="video" mode="generate" />);
    const handles = Array.from(container.querySelectorAll('[data-handleid]'));

    expect(handles.map((handle) => handle.getAttribute('data-handleid'))).toEqual(
      expect.arrayContaining([
        'input:prompt',
        'input:negativePrompt',
        'input:content',
        'input:style',
        'input:character',
        'input:referenceImage',
        'input:firstFrame',
        'input:lastFrame',
        'input:audioTrack',
        'input:transcript',
        'input:mask',
        'output:video',
      ]),
    );
    const semanticHandles = Array.from(
      container.querySelectorAll('.flow-node-semantic-handle'),
    ) as HTMLElement[];
    expect(semanticHandles).toHaveLength(11);
    for (const handle of semanticHandles) {
      expect(handle).toHaveAttribute('data-position', 'left');
      expect(handle).toHaveAttribute('data-connectable', 'false');
      expect(handle.style.top).toBe('50%');
      expect(handle.style.left).toBe('0px');
      expect(handle.style.transform).toBe('translate(-50%, -50%)');
      expect(handle.style.opacity).toBe('0');
      expect(handle.style.pointerEvents).toBe('none');
      expect(handle.style.display).toBe('');
      expect(handle.style.visibility).toBe('');
    }
    expect(
      container.querySelectorAll('[data-handle-type="target"][data-connectable="true"]'),
    ).toHaveLength(1);
    expect(
      container.querySelector('[data-handle-type="target"][data-connectable="true"]'),
    ).toHaveAttribute('data-handleid', 'visual:left');
  });

  it.each(['text', 'image', 'audio', 'video'] as const)(
    '%s 生成节点统一左进右出并保留全部语义输入',
    (mediaType) => {
      const { container } = render(<NodeHandles mediaType={mediaType} mode="generate" />);
      const visible = Array.from(container.querySelectorAll('.flow-node-handle')) as HTMLElement[];
      expect(visible).toHaveLength(2);
      const left = container.querySelector('[data-handle-side="left"]') as HTMLElement;
      const right = container.querySelector('[data-handle-side="right"]') as HTMLElement;
      expect(left).toHaveAttribute('data-position', 'left');
      expect(left).toHaveAttribute('data-handleid', 'visual:left');
      expect(left).toHaveAttribute('data-connectable', 'true');
      expect(left.style.top).toBe('50%');
      expect(left.style.left).toBe('0px');
      expect(left.style.transform).toBe('translate(-50%, -50%)');
      expect(right).toHaveAttribute('data-position', 'right');
      expect(right).toHaveAttribute('data-handleid', `output:${mediaType}`);
      expect(right).toHaveAttribute('data-connectable', 'true');
      expect(right.style.top).toBe('50%');
      expect(right.style.right).toBe('0px');
      expect(right.style.transform).toBe('translate(50%, -50%)');
      expect(
        Array.from(container.querySelectorAll('.flow-node-semantic-handle')).map((handle) =>
          handle.getAttribute('data-handleid'),
        ),
      ).toEqual(targetPortRolesForMediaType(mediaType).map((role) => `input:${role}`));
    },
  );

  it.each(['text', 'image', 'audio', 'video'] as const)(
    '%s 资源节点保留两个位置但仅输出可以连接',
    (mediaType) => {
      const { container } = render(<NodeHandles mediaType={mediaType} mode="source" />);

      expect(container.querySelectorAll('.flow-node-handle')).toHaveLength(2);
      expect(container.querySelectorAll('.flow-node-semantic-handle')).toHaveLength(0);
      expect(
        container.querySelectorAll('[data-handle-type="target"][data-connectable="true"]'),
      ).toHaveLength(0);
      expect(container.querySelector('[data-handleid="visual:left"]')).toHaveAttribute(
        'data-connectable',
        'false',
      );
      expect(container.querySelector(`[data-handleid="output:${mediaType}"]`)).toHaveAttribute(
        'data-connectable',
        'true',
      );
    },
  );

  it.each(videoModes)('%s 模式保留一个通用输入位置以及旧角色标识', (videoMode) => {
    for (const modelAlias of [
      'grok-imagine-video-1.5',
      'wan3.0-video',
      'doubao-seedance-2-5-260628',
    ]) {
      const layout = getNodeHandleLayout('video', 'generate', { videoMode, modelAlias });
      expect(layout.visible).toHaveLength(2);
      expect(layout.visible.find((handle) => handle.side === 'left')).toMatchObject({
        id: 'visual:left',
        type: 'target',
        isConnectable: true,
      });
      expect(layout.semanticInputRoles).toEqual(
        expect.arrayContaining([
          'prompt',
          'negativePrompt',
          'referenceImage',
          'firstFrame',
          'lastFrame',
          'content',
          'audioTrack',
        ]),
      );
      expect(layout.visible.find((handle) => handle.side === 'right')).toMatchObject({
        id: 'output:video',
        type: 'source',
        isConnectable: true,
      });
    }
  });
});

describe('连接点功能说明', () => {
  it('给出输出和不可用输入的明确提示', () => {
    const { container } = render(<NodeHandles mediaType="image" mode="source" />);
    expect(container.querySelector('[data-handle-side="right"]')).toHaveAttribute(
      'title',
      expect.stringContaining('拖到其他节点'),
    );
    const handle = container.querySelector('[data-handle-side="left"]');
    expect(handle).toHaveAttribute('aria-disabled', 'true');
    expect(handle).toHaveAttribute('title', expect.stringContaining('资源节点不接收输入'));
  });

  it('视频模式切换后主输入位置不变且语义角色说明同步', () => {
    const { container, rerender } = render(
      <NodeHandles mediaType="video" mode="generate" videoMode="first_last_frame" />,
    );
    expect(container.querySelector('[data-handleid="input:lastFrame"]')).toHaveAttribute(
      'title',
      expect.stringContaining('尾帧'),
    );
    const input = container.querySelector('[data-handle-side="left"]');
    expect(input).toHaveAttribute('data-handleid', 'visual:left');
    expect(input).toHaveAttribute('data-connectable', 'true');
    rerender(
      <NodeHandles
        mediaType="video"
        mode="generate"
        videoMode="omni_reference"
        modelAlias="minimax-h3"
      />,
    );
    expect(container.querySelectorAll('.flow-node-handle')).toHaveLength(2);
    expect(container.querySelector('[data-handle-side="left"]')).toBe(input);
    expect(input).toHaveAttribute('data-handleid', 'visual:left');
    expect(input).not.toHaveAttribute('aria-disabled');
    expect(container.querySelector('[data-handleid="input:negativePrompt"]')).toHaveAttribute(
      'title',
      expect.stringContaining('负面提示词'),
    );
    expect(container.querySelector('[data-handleid="input:content"]')).toHaveAttribute(
      'title',
      expect.stringContaining('参考视频'),
    );
    expect(container.querySelector('[data-handleid="input:audioTrack"]')).toHaveAttribute(
      'title',
      expect.stringContaining('参考音频'),
    );
  });
});
