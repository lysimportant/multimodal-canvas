import '@testing-library/jest-dom/vitest';

import { render } from '@testing-library/react';
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
  it('renders one centered visible anchor per side', () => {
    const { container } = render(<NodeHandles mediaType="video" mode="generate" />);
    const visibleHandles = Array.from(container.querySelectorAll('.flow-node-handle'));

    expect(visibleHandles).toHaveLength(4);
    expect(visibleHandles.map((handle) => handle.getAttribute('data-handle-side'))).toEqual([
      'top',
      'right',
      'bottom',
      'left',
    ]);
    expect(visibleHandles.map((handle) => handle.getAttribute('data-position'))).toEqual([
      'top',
      'right',
      'bottom',
      'left',
    ]);
  });

  it('keeps every target role available through the hidden hit layer', () => {
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
    expect(container.querySelectorAll('.flow-node-semantic-handle')).toHaveLength(8);
    expect(
      Array.from(container.querySelectorAll('.flow-node-semantic-handle')).every(
        (handle) =>
          (handle as HTMLElement).style.top === '50%' &&
          (handle as HTMLElement).style.left === '0px' &&
          (handle as HTMLElement).style.transform === 'translate(-50%, -50%)',
      ),
    ).toBe(true);
  });

  it('keeps the primary roles on the centered target anchors', () => {
    const { visible } = getNodeHandleLayout('video', 'generate');
    const handlesBySide = new Map(visible.map((handle) => [handle.side, handle]));

    expect((['top', 'left', 'bottom'] as const).map((side) => handlesBySide.get(side)?.id)).toEqual(
      ['input:prompt', 'input:firstFrame', 'input:negativePrompt'],
    );
  });

  it.each(['text', 'image', 'audio', 'video'] as const)(
    '%s 节点四边可见锚点都使用同一套居中坐标',
    (mediaType) => {
      const { container } = render(<NodeHandles mediaType={mediaType} mode="generate" />);
      const visible = Array.from(container.querySelectorAll('.flow-node-handle')) as HTMLElement[];
      expect(visible.map((handle) => handle.getAttribute('data-handle-side'))).toEqual([
        'top',
        'right',
        'bottom',
        'left',
      ]);
      expect(visible.map((handle) => handle.style.transform)).toEqual([
        'translate(-50%, -50%)',
        'translate(50%, -50%)',
        'translate(-50%, 50%)',
        'translate(-50%, -50%)',
      ]);
      expect(visible[0].style.top).toBe('0px');
      expect(visible[1].style.right).toBe('0px');
      expect(visible[2].style.bottom).toBe('0px');
      expect(visible[3].style.left).toBe('0px');
    },
  );

  it('does not expose connectable input handles on source nodes', () => {
    const { container } = render(<NodeHandles mediaType="image" mode="source" />);

    expect(container.querySelectorAll('.flow-node-semantic-handle')).toHaveLength(0);
    expect(
      container.querySelectorAll('[data-handle-type="target"][data-connectable="true"]'),
    ).toHaveLength(0);
    expect(container.querySelector('[data-handleid="output:image"]')).toBeInTheDocument();
  });
});
