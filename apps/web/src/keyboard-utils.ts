/**
 * 判断键盘事件是否来自自行处理键盘交互的控件，包括其内部文本和图标。
 *
 * @param target 键盘事件的原始目标；空目标或非元素目标不拦截。
 * @returns 按钮、链接、可编辑区域及 ARIA 菜单、列表及标签页控件返回 true，调用方应跳过画布快捷键。
 */
export function isCanvasShortcutTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object' || !('closest' in target)) return false;

  const element = target as HTMLElement;
  if (typeof element.closest !== 'function') return false;

  if (element.isContentEditable) return true;

  return Boolean(
    element.closest(
      'button, a, input, textarea, select, [contenteditable="true"], ' +
        '[role="button"], [role="textbox"], [role="combobox"], ' +
        '[role="menu"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], ' +
        '[role="listbox"], [role="option"], [role="tab"], [role="tablist"], [role="tabpanel"]',
    ),
  );
}
