import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** 画布样式契约；归一化空白以忽略排版，不依赖 jsdom 的布局计算。 */
const indexCss = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8').replace(/\s+/g, ' ');
/** 快速编辑器的共用样式，用于确认桌面覆盖不影响放大弹窗。 */
const editorCss = readFileSync(
  resolve(process.cwd(), 'src/workspace/node-quick-editor.css'),
  'utf8',
).replace(/\s+/g, ' ');

/** 输入框决定滚动容器高度，文字层不再单独固定尺寸。 */
const layoutCss = readFileSync(
  resolve(process.cwd(), 'src/workspace/node-quick-editor-layout.css'),
  'utf8',
).replace(/\s+/g, ' ');

// CSS 契约只覆盖尺寸边界；实际视口位置与滚动仍需浏览器视觉验收。
describe('桌面节点输入区高度', () => {
  it('文字层铺满输入容器，不保留独立固定高度或移动端高度覆盖', () => {
    expect(layoutCss).toMatch(
      /\.node-quick-editor \.node-quick-editor-prompt \.resource-mention-highlight \{ height: auto; max-height: none; min-height: 0; overflow-y: auto; \}/,
    );
    expect(layoutCss.match(/\.resource-mention-highlight/g)).toHaveLength(1);
    expect(indexCss).toMatch(
      /\.resource-mention-highlight \{[^}]*bottom: 0;[^}]*position: absolute;[^}]*top: 0;/,
    );
  });
  it('仅为桌面浮层的提示词输入区增加固定初始高度，并保留内部滚动', () => {
    expect(indexCss).toMatch(
      /@media \(min-width: 901px\) \{ \.quick-editor-overlay \.node-quick-editor \.node-quick-editor-prompt textarea \{ height: 180px; min-height: 180px; max-height: 240px; overflow-y: auto; \} \}/,
    );
  });

  it('保留其它视口的共用最小高度与放大弹窗的视口高度限制', () => {
    expect(editorCss).toMatch(
      /:is\(\.node-quick-editor, \.node-quick-editor-dialog\) \.node-quick-editor-field textarea \{[^}]*min-height: 145px;/,
    );
    expect(editorCss).toMatch(
      /\.node-quick-editor-dialog \.node-quick-editor-prompt textarea \{ min-height: min\(360px, 45dvh\); max-height: 55dvh;/,
    );
    expect(indexCss).toMatch(
      /\.node-quick-editor-prompt textarea \{ max-height: 180px; min-height: 102px; \}/,
    );
  });

  it('保留输入框的显式纵向拖拽，而非根据内容自动增长', () => {
    expect(indexCss).toMatch(/\.node-quick-editor-field textarea \{[^}]*resize: vertical;/);
  });

  it('保留节点外框和预览隔离，长内容不得撑大用户设定的节点尺寸', () => {
    expect(indexCss).toMatch(/\.flow-asset-node \{[^}]*height: 100%;[^}]*min-height: 0;/);
    expect(indexCss).toMatch(
      /\.flow-node-preview \{[^}]*flex: 1 1 0;[^}]*min-height: 0;[^}]*max-height: 100%;[^}]*overflow: hidden;/,
    );
    expect(indexCss).toMatch(
      /\.flow-node-preview \{ contain: layout paint; min-height: 0; overflow: hidden; \}/,
    );
  });

  it('保留浮层定位和可用高度约束，低矮视口仍在编辑器内部滚动', () => {
    expect(indexCss).toMatch(/\.quick-editor-overlay \{[^}]*position: fixed;/);
    expect(indexCss).toMatch(
      /\.quick-editor-overlay > \.node-quick-editor \{ max-height: var\(--quick-editor-max-height, calc\(100dvh - 16px\)\); overflow-y: auto; overscroll-behavior: contain;/,
    );
  });
});
