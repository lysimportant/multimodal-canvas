import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/** 待集成的原生滚动条样式，不通过入口导入以免改变现有页面。 */
const scrollbarCss = readFileSync(resolve(process.cwd(), 'src/native-scrollbars.css'), 'utf8');
/** 现有主题令牌是配色合同的唯一来源，不在测试里复制颜色值。 */
const themeCss = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
/** 仅加载主题变量块，避免把应用布局及构建期 CSS 指令引入合同测试。 */
const themeTokenRules = themeCss.match(
  /(?:^|\n)(?::root|\[data-theme=)[^{}]*\{[^{}]*--mc-text-muted:[^{}]*\}/g,
);
/** 当前主题及兼容别名；只有深色组使用深色原生控件。 */
const themes = [
  ['light', 'light'],
  ['white', 'light'],
  ['eye-care', 'light'],
  ['eyecare', 'light'],
  ['green', 'light'],
  ['dark', 'dark'],
  ['midnight', 'dark'],
  ['sepia', 'light'],
  ['warm', 'light'],
  ['contrast', 'light'],
  ['high-contrast', 'light'],
] as const;

/**
 * 将现有六位十六进制主题颜色转换为相对亮度，以核验滑块与轨道的对比度。
 * @param color 主题令牌的 #RRGGBB 颜色；格式不符时断言失败。
 * @returns 0 到 1 的 sRGB 相对亮度。
 */
function luminance(color: string): number {
  expect(color).toMatch(/^#[\da-f]{6}$/i);
  const channels = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(color.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

describe('原生滚动条主题合同', () => {
  let style: HTMLStyleElement;
  let shell: HTMLElement;
  let previousTheme: string | undefined;

  beforeEach(() => {
    previousTheme = document.documentElement.dataset.theme;
    delete document.documentElement.dataset.theme;
    expect(themeTokenRules).not.toBeNull();
    style = document.createElement('style');
    style.textContent = `${themeTokenRules!.join('\n')}\n${scrollbarCss}`;
    document.head.append(style);
    shell = document.createElement('main');
    shell.className = 'app-shell';
    document.body.append(shell);
  });

  afterEach(() => {
    shell.remove();
    style.remove();
    if (previousTheme === undefined) {
      delete document.documentElement.dataset.theme;
    } else {
      document.documentElement.dataset.theme = previousTheme;
    }
  });

  it('无主题属性时使用浅色原生控件并复用根令牌', () => {
    const css = getComputedStyle(document.documentElement);
    expect(css.getPropertyValue('color-scheme')).toBe('light');
    expect(css.getPropertyValue('scrollbar-color')).toBe(
      'var(--mc-text-muted) var(--mc-surface-muted)',
    );
    expect(css.getPropertyValue('--mc-text-muted')).not.toBe('');
    expect(css.getPropertyValue('--mc-surface-muted')).not.toBe('');
  });

  for (const target of ['root', 'shell'] as const) {
    it.each(themes)(`${target} 的 %s 主题复用令牌并提供可辨识的原生配色`, (theme, scheme) => {
      const element = target === 'root' ? document.documentElement : shell;
      // 浅色外壳必须能够覆盖深色根元素，不能只依赖根元素的继承值。
      document.documentElement.dataset.theme = 'dark';
      element.dataset.theme = theme;
      const css = getComputedStyle(element);
      expect(css.getPropertyValue('color-scheme')).toBe(scheme);
      expect(css.getPropertyValue('scrollbar-color')).toBe(
        'var(--mc-text-muted) var(--mc-surface-muted)',
      );
      const thumb = luminance(css.getPropertyValue('--mc-text-muted').trim());
      const track = luminance(css.getPropertyValue('--mc-surface-muted').trim());
      expect(
        (Math.max(thumb, track) + 0.05) / (Math.min(thumb, track) + 0.05),
      ).toBeGreaterThanOrEqual(3);
    });
  }

  it('强制颜色模式将原生控件配色交回系统', () => {
    // jsdom 不模拟系统强制颜色；这里检查实际媒体规则，现场行为由浏览器烟测验证。
    const rules = Array.from(style.sheet!.cssRules);
    const forcedColors = rules.find((rule) => rule.type === CSSRule.MEDIA_RULE) as CSSMediaRule;
    expect(forcedColors.conditionText).toBe('(forced-colors: active)');
    const reset = forcedColors.cssRules[0] as CSSStyleRule;
    expect(reset.selectorText.replace(/\s+/g, ' ')).toBe(':root, [data-theme]');
    expect(reset.style.getPropertyValue('scrollbar-color')).toBe('auto');
    expect(reset.style.getPropertyValue('color-scheme')).toBe('light dark');
    expect(rules.at(-1)).toBe(forcedColors);
  });

  it('只调整标准原生颜色，不缩窄、隐藏滚动条或修改布局与节点样式', () => {
    const declarations = Array.from(scrollbarCss.matchAll(/^\s*([\w-]+):\s*(.+);/gm));
    expect([...new Set(declarations.map(([, property]) => property))].sort()).toEqual([
      'color-scheme',
      'scrollbar-color',
    ]);
    expect(scrollbarCss).not.toMatch(/::-(?:webkit|moz)-|!important|forced-color-adjust|\.flow-/);
  });
});
