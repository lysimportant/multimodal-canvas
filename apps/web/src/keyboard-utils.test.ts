import { describe, expect, it } from 'vitest';

import { isCanvasShortcutTarget } from './keyboard-utils';

describe('canvas keyboard shortcut guard', () => {
  const target = (options: { contentEditable?: boolean; control?: boolean } = {}) =>
    ({
      isContentEditable: options.contentEditable ?? false,
      closest: () => (options.control ? {} : null),
    }) as unknown as EventTarget;

  it('ignores events from form controls and their descendants', () => {
    expect(isCanvasShortcutTarget(target({ control: true }))).toBe(true);
    expect(isCanvasShortcutTarget(target())).toBe(false);
    expect(isCanvasShortcutTarget(null)).toBe(false);
  });

  it('ignores events from buttons, links, and ARIA controls', () => {
    expect(isCanvasShortcutTarget(target({ control: true }))).toBe(true);
  });

  it('ignores events from editable ancestors', () => {
    expect(isCanvasShortcutTarget(target({ contentEditable: true }))).toBe(true);
  });

  it('allows events from the canvas pane', () => {
    expect(isCanvasShortcutTarget(target())).toBe(false);
  });
});
