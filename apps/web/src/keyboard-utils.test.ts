import { describe, expect, it } from 'vitest';

import { isCanvasShortcutTarget } from './keyboard-utils';

describe('画布快捷键交互边界', () => {
  it.each(['button', 'a', 'input', 'textarea', 'select'])('忽略原生 %s 控件的键盘事件', (tag) => {
    expect(isCanvasShortcutTarget(document.createElement(tag))).toBe(true);
  });

  it.each(['button', 'a'])('忽略 %s 内部文本和图标的键盘事件', (tag) => {
    const control = document.createElement(tag);
    const text = document.createElement('span');
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    icon.append(path);
    control.append(text, icon);

    expect(isCanvasShortcutTarget(text)).toBe(true);
    expect(isCanvasShortcutTarget(path)).toBe(true);
  });

  it.each(['button', 'textbox', 'combobox'])('保留 ARIA %s 的交互边界', (role) => {
    const control = document.createElement('div');
    const child = document.createElement('span');
    control.setAttribute('role', role);
    control.append(child);

    expect(isCanvasShortcutTarget(control)).toBe(true);
    expect(isCanvasShortcutTarget(child)).toBe(true);
  });

  it.each([
    ['menu', 'ul'],
    ['menuitem', 'li'],
    ['menuitemcheckbox', 'li'],
    ['menuitemradio', 'li'],
    ['listbox', 'div'],
    ['option', 'div'],
    ['tab', 'div'],
    ['tablist', 'div'],
    ['tabpanel', 'div'],
  ] as const)('忽略组件库 %s 本身及内部文本、SVG 图标的键盘事件', (role, tag) => {
    const control = document.createElement(tag);
    const child = document.createElement(tag === 'ul' ? 'li' : 'span');
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    control.setAttribute('role', role);
    icon.append(path);
    child.append(icon);
    control.append(child);

    expect(isCanvasShortcutTarget(control)).toBe(true);
    expect(isCanvasShortcutTarget(child)).toBe(true);
    expect(isCanvasShortcutTarget(path)).toBe(true);
  });

  it('忽略可编辑区域及其子元素的键盘事件', () => {
    const editable = document.createElement('div');
    const child = document.createElement('span');
    editable.setAttribute('contenteditable', 'true');
    editable.append(child);

    expect(isCanvasShortcutTarget(editable)).toBe(true);
    expect(isCanvasShortcutTarget(child)).toBe(true);
  });

  it('画布及普通节点仍可使用快捷键，不因同级菜单存在而被拦截', () => {
    const canvas = document.createElement('div');
    const pane = document.createElement('div');
    const node = document.createElement('div');
    const nodeLabel = document.createElement('span');
    const menu = document.createElement('ul');
    canvas.className = 'canvas-area';
    pane.className = 'react-flow__pane';
    pane.setAttribute('role', 'application');
    pane.tabIndex = 0;
    node.className = 'react-flow__node';
    node.tabIndex = 0;
    node.append(nodeLabel);
    node.setAttribute('role', 'group');
    menu.setAttribute('role', 'menu');
    canvas.append(pane, node, menu);

    expect(isCanvasShortcutTarget(canvas)).toBe(false);
    expect(isCanvasShortcutTarget(pane)).toBe(false);
    expect(isCanvasShortcutTarget(node)).toBe(false);
    expect(isCanvasShortcutTarget(nodeLabel)).toBe(false);
  });

  it('空目标和非元素目标不阻断画布快捷键', () => {
    expect(isCanvasShortcutTarget(null)).toBe(false);
    expect(isCanvasShortcutTarget(document)).toBe(false);
    expect(isCanvasShortcutTarget(window)).toBe(false);
    expect(isCanvasShortcutTarget(new EventTarget())).toBe(false);
  });
});
