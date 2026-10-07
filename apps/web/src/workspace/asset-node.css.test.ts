import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const assetNodeCss = readFileSync(resolve(process.cwd(), 'src/workspace/asset-node.css'), 'utf8');
const normalizedCss = assetNodeCss.replace(/\s+/g, ' ');

describe('asset node floating controls CSS contracts', () => {
  it('节点普通、悬停和选中状态均不显示外框，不改变节点内容区域', () => {
    for (const selector of [
      '.react-flow__node .flow-asset-node',
      '.react-flow__node .flow-asset-node:hover',
      '.react-flow__node .flow-asset-node.is-selected, .react-flow__node .flow-asset-node.is-selected:hover',
    ]) {
      expect(normalizedCss.slice(normalizedCss.indexOf(selector + ' {')).split('}')[0]).toContain(
        'border: 0;',
      );
    }
    expect(normalizedCss).not.toContain('border-width: 3px;');
  });

  it('悬浮卡片随图标和文字收缩，不左右分栏且始终显示功能简述', () => {
    expect(normalizedCss).toMatch(
      /\.flow-asset-node > \.flow-node-header\.flow-node-floating-controls \{[^}]*width: max-content;/,
    );
    expect(normalizedCss).not.toContain('min-width: calc(100% * var(--flow-node-zoom, 1))');
    expect(normalizedCss).not.toContain('min-width: max(250px,');
    expect(normalizedCss).not.toMatch(
      /\.flow-node-floating-controls > \.flow-node-label \{[^}]*width: 100px;/,
    );
    expect(normalizedCss).not.toContain('.flow-node-floating-controls > .flow-node-actions');
    expect(normalizedCss).not.toContain('is-spacious');
    expect(normalizedCss).toContain(
      'transform: translateX(-50%) scale(var(--flow-node-inverse-zoom, 1));',
    );
    expect(normalizedCss).toContain('transform-origin: bottom center;');
    expect(normalizedCss).toContain('left: 50%;');
    expect(normalizedCss).toContain('width: max-content;');
    expect(normalizedCss).toContain('gap: 12px;');
    expect(normalizedCss).toContain('padding: 8px 14px;');
    expect(normalizedCss).toMatch(
      /\.flow-node-floating-controls \.flow-node-action-button \{[^}]*min-width: max-content;/,
    );
    expect(normalizedCss).toMatch(/\.flow-node-action-label \{[^}]*font-size: 13px;/);
    expect(normalizedCss).toMatch(/\.flow-node-action-label \{[^}]*display: inline;/);
  });
});

describe('asset node action item CSS', () => {
  let style: HTMLStyleElement;
  let fixture: HTMLDivElement;

  beforeEach(() => {
    style = document.createElement('style');
    style.textContent = assetNodeCss;
    document.head.append(style);
    fixture = document.createElement('div');
    fixture.innerHTML = `
      <div class="flow-node-header flow-node-floating-controls">
        <button class="ant-btn flow-node-action-button flow-node-drag-handle" id="move">移动</button>
        <button class="ant-btn flow-node-action-button flow-node-upload-button" id="upload">上传</button>
        <button class="ant-btn flow-node-action-button flow-node-delete-button" id="delete">删除</button>
        <button class="ant-btn flow-node-action-button flow-node-upload-button" disabled id="disabled">上传</button>
        <span class="flow-node-action-button flow-node-floating-duration" tabindex="0" id="duration">耗时</span>
      </div>
      <div class="flow-node-header">
        <button class="flow-node-delete-button" id="ordinary-delete">删除</button>
      </div>
    `;
    document.body.append(fixture);
  });

  afterEach(() => {
    fixture.remove();
    style.remove();
  });

  /** 检查原生按钮与只读项的实际 CSS 选择器匹配，不复制生产规则。 */
  function actionStyle(id: string) {
    return getComputedStyle(fixture.querySelector<HTMLElement>(`#${id}`)!);
  }

  it('操作项留白一致，旧上传和删除规则不能清零 padding 或固定 flex 宽度', () => {
    for (const id of ['move', 'upload', 'delete', 'disabled', 'duration']) {
      const css = actionStyle(id);
      expect(css.padding).toBe('6px 8px');
      expect(css.borderTopWidth).toBe('0px');
      expect(css.flex).toBe('0 0 auto');
    }
    expect(actionStyle('move').cursor).toBe('grab');
    expect(actionStyle('ordinary-delete').padding).toBe('0px');
    expect(actionStyle('ordinary-delete').width).toBe('40px');
  });

  it('hover、active 和 focus 明确覆盖 Ant Button 的整条 border，危险项仍为原警示色', () => {
    const interactiveRule = normalizedCss.match(
      /\.flow-node-floating-controls \.flow-node-action-button:not\(:disabled\):not\(\.ant-btn-disabled\):is\(\s*:hover, :active, :focus-visible\s*\) \{([^}]+)\}/,
    )?.[1];
    expect(interactiveRule).toContain('border: 0;');
    expect(interactiveRule).toContain('box-shadow: none;');
    expect(interactiveRule).toContain('background-color: var(--mc-accent-soft);');
    expect(interactiveRule).toContain('color: var(--mc-accent-strong);');
    fixture.querySelector<HTMLButtonElement>('#delete')!.focus();
    const danger = actionStyle('delete');
    expect(danger.borderTopWidth).toBe('0px');
    expect(danger.boxShadow).toBe('none');
    expect(danger.color).toBe('rgb(191, 66, 55)');
  });

  it('键盘焦点可见但不再绘制外框，禁用按钮不带 hover 底色', () => {
    fixture.querySelector<HTMLButtonElement>('#move')!.focus();
    expect(actionStyle('move').outline).toBe('none');
    expect(actionStyle('move').textDecoration).toBe('underline');
    expect(actionStyle('move').backgroundColor).toBe('var(--mc-accent-soft)');
    expect(actionStyle('disabled').backgroundColor).toBe('rgba(0, 0, 0, 0)');
    expect(actionStyle('disabled').cursor).toBe('not-allowed');
    expect(actionStyle('disabled').boxShadow).toBe('none');
  });

  it('减少动态效果时关闭新增按钮过渡和图标位移', () => {
    const rules = Array.from(style.sheet!.cssRules)
      .filter(
        (rule): rule is CSSMediaRule =>
          rule instanceof CSSMediaRule && rule.conditionText === '(prefers-reduced-motion: reduce)',
      )
      .flatMap((rule) => Array.from(rule.cssRules) as CSSStyleRule[])
      .filter((rule) => rule.selectorText.includes('flow-node-action-button'));
    expect(rules.some((rule) => rule.style.getPropertyValue('transition') === 'none')).toBe(true);
    expect(rules.some((rule) => rule.style.getPropertyValue('transform') === 'none')).toBe(true);
  });
});
