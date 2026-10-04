import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** 读取共享表格规则，避免独立设置页的局部覆盖掩盖项目弹窗缺陷。 */
const source = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
const tableCss = source.slice(
  source.indexOf('.settings-models-table-wrap {'),
  source.indexOf('/* 宽版设置：'),
);
const style = document.createElement('style');

beforeAll(() => {
  style.textContent = tableCss;
  document.head.append(style);
});

afterAll(() => style.remove());

/** 返回实际选择器的声明；缺失规则时失败，不用测试内副本兜底。 */
function declarations(selector: string) {
  const rule = Array.from(style.sheet!.cssRules).find(
    (entry) => (entry as CSSStyleRule).selectorText.replace(/\s+/g, ' ') === selector,
  ) as CSSStyleRule | undefined;
  expect(rule, selector).toBeDefined();
  return rule!.style;
}

/** 将仓库六位十六进制颜色转换为相对亮度，用于验证小字号文字对比度。 */
function luminance(hex: string) {
  expect(hex).toMatch(/^#[\da-f]{6}$/i);
  const [red, green, blue] = hex.match(/[\da-f]{2}/gi)!.map((channel) => {
    const value = parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}

describe('设置分组表格共享主题', () => {
  it('容器与数据区显式沿用主题底色和正文色，不依赖页面专属补丁', () => {
    const wrapper = declarations('.settings-models-table-wrap');
    expect(wrapper.getPropertyValue('border')).toBe('1px solid var(--mc-border)');
    const table = declarations('.settings-models-table');
    expect(table.getPropertyValue('background')).toBe('var(--mc-surface)');
    expect(table.getPropertyValue('color')).toBe('var(--mc-text)');
  });

  it('表头底色与文字成对使用主题变量', () => {
    const header = declarations('.settings-models-table th');
    expect(header.getPropertyValue('background')).toBe('var(--mc-surface-soft)');
    expect(header.getPropertyValue('color')).toBe('var(--mc-text-muted)');
  });

  it('单元格与分组代码不保留固定浅色主题的边框或字色', () => {
    const cells = declarations('.settings-models-table th, .settings-models-table td');
    expect(cells.getPropertyValue('border-bottom')).toBe('1px solid var(--mc-border)');
    expect(cells.getPropertyValue('color')).toBe('var(--mc-text)');
    expect(declarations('.settings-models-table code').getPropertyValue('color')).toBe(
      'var(--mc-text)',
    );
    expect(tableCss).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(/i);
  });

  it('保留滚动容器、单元格留白和吸顶表头的既有布局', () => {
    const wrapper = declarations('.settings-models-table-wrap');
    expect(wrapper.getPropertyValue('max-height')).toBe('260px');
    expect(wrapper.getPropertyValue('overflow')).toBe('auto');
    expect(declarations('.settings-models-table').getPropertyValue('min-width')).toBe('100%');
    const cells = declarations('.settings-models-table th, .settings-models-table td');
    expect(cells.getPropertyValue('padding')).toBe('9px 10px');
    expect(cells.getPropertyValue('white-space')).toBe('nowrap');
    const header = declarations('.settings-models-table th');
    expect(header.getPropertyValue('position')).toBe('sticky');
    expect(header.getPropertyValue('top')).toBe('0');
  });

  it.each(['eye-care', 'light', 'dark', 'sepia', 'contrast'])(
    '%s 主题的表头、正文和代码配色满足 4.5:1 文字对比度',
    (theme) => {
      const start = source.indexOf(`[data-theme='${theme}']`);
      expect(start).toBeGreaterThanOrEqual(0);
      const palette = source.slice(source.indexOf('{', start), source.indexOf('}', start));
      const tokens = Object.fromEntries(
        Array.from(palette.matchAll(/(--mc-[\w-]+):\s*(#[\da-f]{6});/gi)).map(([, name, value]) => [
          name,
          value,
        ]),
      );
      for (const [foreground, background] of [
        ['--mc-text-muted', '--mc-surface-soft'],
        ['--mc-text', '--mc-surface'],
      ]) {
        const text = luminance(tokens[foreground!]!);
        const surface = luminance(tokens[background!]!);
        expect(
          (Math.max(text, surface) + 0.05) / (Math.min(text, surface) + 0.05),
        ).toBeGreaterThanOrEqual(4.5);
      }
    },
  );
});
