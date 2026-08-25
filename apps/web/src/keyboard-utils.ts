/**
 * Returns whether a keyboard event originated in a control that owns the
 * keyboard interaction. Canvas shortcuts should not consume those events.
 */
export function isCanvasShortcutTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object' || !('closest' in target)) return false;

  const element = target as HTMLElement;
  if (typeof element.closest !== 'function') return false;

  if (element.isContentEditable) return true;

  return Boolean(
    element.closest(
      'button, a, input, textarea, select, [contenteditable="true"], [role="button"], [role="textbox"], [role="combobox"]',
    ),
  );
}
