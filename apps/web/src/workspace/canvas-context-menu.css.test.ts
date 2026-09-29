import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/** 直接加载菜单样式，检查真实选择器而非复制规则。 */
const menuCss = readFileSync(
  resolve(process.cwd(), 'src/workspace/canvas-context-menu.css'),
  'utf8',
);

/** 每个用例独立挂载样式与菜单，避免影响其它模块的 DOM。 */
let style: HTMLStyleElement;
let fixture: HTMLDivElement;

beforeEach(() => {
  style = document.createElement('style');
  style.textContent = menuCss;
  document.head.append(style);
  fixture = document.createElement('div');
  fixture.innerHTML = `
    <div class="ant-dropdown canvas-context-dropdown" id="root">
      <ul class="ant-dropdown-menu" id="list">
        <li class="ant-dropdown-menu-item" tabindex="-1" id="item">操作</li>
        <li class="ant-dropdown-menu-item ant-dropdown-menu-item-active" id="active">操作</li>
        <li class="ant-dropdown-menu-item ant-dropdown-menu-item-active ant-dropdown-menu-item-disabled" id="disabled">禁用</li>
        <li class="ant-dropdown-menu-item ant-dropdown-menu-item-active ant-dropdown-menu-item-danger" id="danger">删除</li>
      </ul>
    </div>
    <div class="ant-dropdown-menu-submenu canvas-context-dropdown" id="submenu">
      <ul class="ant-dropdown-menu" id="sublist">
        <li class="ant-dropdown-menu-item" id="subitem">子项</li>
        <li class="ant-dropdown-menu-submenu ant-dropdown-menu-submenu-disabled">
          <div class="ant-dropdown-menu-submenu-title" id="disabled-submenu">禁用分组</div>
        </li>
      </ul>
    </div>
    <div class="ant-dropdown"><ul class="ant-dropdown-menu"><li class="ant-dropdown-menu-item" id="unrelated">其它菜单</li></ul></div>
  `;
  document.body.append(fixture);
});

afterEach(() => {
  fixture.remove();
  style.remove();
});

/** 返回当前菜单夹具的计算样式；缺失元素直接使测试失败。 */
function itemStyle(id: string) {
  return getComputedStyle(fixture.querySelector<HTMLElement>(`#${id}`)!);
}

describe('canvas context menu CSS', () => {
  it('菜单项无边框，保留足够行高与内边距，子菜单一致', () => {
    for (const id of ['item', 'active', 'disabled', 'subitem']) {
      const css = itemStyle(id);
      expect(css.borderTopWidth).toBe('0px');
      expect(css.boxShadow).toBe('none');
      expect(css.padding).toBe('9px 12px');
      expect(css.minHeight).toBe('38px');
    }
    expect(itemStyle('list').padding).toBe('6px');
    expect(itemStyle('unrelated').padding).toBe('');
  });

  it('活动项沿用主题底色，不覆盖禁用和危险项的语义颜色', () => {
    expect(itemStyle('active').backgroundColor).toBe('var(--mc-accent-soft, #edf7f2)');
    expect(itemStyle('active').color).toBe('var(--mc-accent-strong, #12613e)');
    for (const id of ['disabled', 'danger', 'disabled-submenu']) {
      expect(itemStyle(id).backgroundColor).not.toContain('--mc-accent-soft');
    }
  });

  it('键盘焦点用下划线和填色替代外框', () => {
    fixture.querySelector<HTMLElement>('#item')!.focus();
    const css = itemStyle('item');
    expect(css.outline).toBe('none');
    expect(css.textDecoration).toBe('underline');
    expect(css.backgroundColor).toBe('var(--mc-accent-soft, #edf7f2)');
  });

  it('外层不裁切，主列表和 portal 子列表各自限高滚动，不重画面板', () => {
    for (const id of ['root', 'submenu']) {
      const css = itemStyle(id);
      expect(css.overflow).toBe('visible');
      expect(css.boxShadow).toBe('');
      expect(css.borderTopWidth).toBe('');
    }
    for (const id of ['list', 'sublist']) {
      const css = itemStyle(id);
      expect(css.maxHeight).toBe('calc(100vh - 16px)');
      expect(css.overflowY).toBe('auto');
    }
    expect(itemStyle('disabled-submenu').paddingInlineEnd).toBe('32px');
  });

  it('减少动态效果设置关闭过渡与图标位移', () => {
    const reducedMotion = Array.from(style.sheet!.cssRules).find(
      (rule): rule is CSSMediaRule =>
        rule instanceof CSSMediaRule && rule.conditionText === '(prefers-reduced-motion: reduce)',
    );
    expect(reducedMotion).toBeDefined();
    const declarations = Array.from(reducedMotion!.cssRules).map(
      (rule) => (rule as CSSStyleRule).style,
    );
    expect(declarations.some((rule) => rule.getPropertyValue('transition') === 'none')).toBe(true);
    expect(declarations.some((rule) => rule.getPropertyValue('transform') === 'none')).toBe(true);
  });
});
