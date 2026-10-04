import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** 短枚举样式契约；真实四档宽度与换行由隔离浏览器用例验证。 */
const editorCss = readFileSync(
  resolve(process.cwd(), 'src/workspace/node-quick-editor.css'),
  'utf8',
).replace(/\s+/g, ' ');

/** 仅检查短枚举选项，避免把模型长名称列表纳入紧凑布局。 */
const optionRule = editorCss.match(
  /\.node-parameter-options \.node-parameter-grid \[role='option'\] \{([^}]+)\}/,
)?.[1];

describe('节点参数短枚举布局', () => {
  it('禁止尾项拉伸，图片第四档清晰度换行后不独占整行宽度', () => {
    expect(optionRule).toBeDefined();
    expect(optionRule).toContain('flex: 0 1 max-content;');
  });

  it('保留三列最小宽度与内容宽度，短清晰度紧凑排列且长比例可换行', () => {
    expect(optionRule).toContain('min-width: calc(100% / 3);');
    expect(optionRule).toContain('max-width: 100%;');
    expect(editorCss).toMatch(
      /\.node-parameter-options \.node-parameter-grid \[role='listbox'\] \{[^}]*display: flex !important;[^}]*flex-flow: row wrap !important;/,
    );
  });

  it('标签不换行仅作用于短枚举，不限制模型长名称的自然换行', () => {
    expect(editorCss).toMatch(
      /\.node-parameter-grid \.node-quick-editor-option-copy :is\(strong, small\) \{[^}]*white-space: nowrap;/,
    );
  });
});
