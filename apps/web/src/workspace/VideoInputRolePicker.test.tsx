import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { VideoInputRolePicker } from './VideoInputRolePicker';

afterEach(() => {
  cleanup();
});

describe('VideoInputRolePicker', () => {
  it('\u9009\u62e9\u89d2\u8272\u540e\u628a\u89d2\u8272\u4ea4\u56de\u8c03\u7528\u65b9\uff0c\u53d6\u6d88\u5219\u4e0d\u521b\u5efa\u8fde\u7ebf', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onClose = vi.fn();

    render(
      <VideoInputRolePicker
        target={{
          connection: {
            source: 'image-1',
            target: 'video-1',
            sourceHandle: 'output:image',
            targetHandle: null,
          },
          clientPosition: { x: 40, y: 80 },
        }}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );

    expect(
      screen.getByRole('menu', {
        name: '\u9009\u62e9\u56fe\u7247\u5728\u89c6\u9891\u4e2d\u7684\u7528\u9014',
      }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: /\u901a\u7528\u53c2\u8003/ }));
    expect(onSelect).toHaveBeenCalledWith('referenceImage');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('\u6309 Escape \u5173\u95ed\u83dc\u5355\u4e14\u4e0d\u9009\u89d2\u8272', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onClose = vi.fn();

    render(
      <VideoInputRolePicker
        target={{
          connection: {
            source: 'image-1',
            target: 'video-1',
            sourceHandle: 'output:image',
            targetHandle: null,
          },
          clientPosition: { x: 40, y: 80 },
        }}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );

    await user.keyboard('{Escape}');
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
