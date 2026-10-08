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

/** 节点悬浮栏的内容隔离不能裁剪端口或改变外框尺寸。 */
const nodeCss = readFileSync(
  resolve(process.cwd(), 'src/workspace/asset-node.css'),
  'utf8',
).replace(/\s+/g, ' ');

// CSS 契约只覆盖尺寸边界；实际视口位置与滚动仍需浏览器视觉验收。
describe('桌面节点输入区高度', () => {
  it('隐藏操作栏跳过内部排版与绘制，悬停、选择和键盘聚焦均恢复内容', () => {
    expect(nodeCss).toMatch(
      /\.flow-asset-node > \.flow-node-header\.flow-node-floating-controls \{[^}]*content-visibility: hidden;[^}]*visibility: hidden;/,
    );
    expect(nodeCss).toMatch(
      /\.flow-asset-node:hover > \.flow-node-floating-controls, \.flow-asset-node\.is-selected > \.flow-node-floating-controls, \.flow-asset-node:focus-within > \.flow-node-floating-controls, \.react-flow__node:focus-within \.flow-node-floating-controls \{[^}]*content-visibility: visible;[^}]*visibility: visible;/,
    );
    expect(nodeCss).not.toMatch(/\.react-flow__node \{[^}]*content-visibility:/);
  });

  it('选区模式覆盖悬停、选中与焦点的操作栏显示，不隐藏节点或预览', () => {
    const parentSelector =
      '.canvas-area.is-selection-mode .flow-asset-node > .flow-node-header.flow-node-floating-controls';
    const isolatedSelector =
      ".flow-asset-node[data-selection-mode='true'] > .flow-node-header.flow-node-floating-controls";
    const suppression = nodeCss.slice(nodeCss.indexOf(parentSelector)).split('}')[0];
    expect(suppression).toContain(parentSelector + ', ' + isolatedSelector + ' {');
    expect(suppression).toContain('content-visibility: hidden;');
    expect(suppression).toContain('visibility: hidden;');
    expect(suppression).toContain('opacity: 0;');
    expect(suppression).toContain('pointer-events: none;');
    expect(suppression).toContain('transition: none;');
    expect(nodeCss.indexOf(parentSelector)).toBeGreaterThan(
      nodeCss.indexOf('.react-flow__node:focus-within .flow-node-floating-controls'),
    );
    const modeRules = nodeCss
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('}')
      .filter((rule) => /is-selection-mode|data-selection-mode/.test(rule));
    expect(modeRules).toHaveLength(1);
    expect(modeRules[0]?.split('{')[0].trim()).toBe(parentSelector + ', ' + isolatedSelector);
    expect(suppression).not.toMatch(/(?:display|width|height):/);
  });

  it('设置栏可换行且放大固定在顶部右侧，不改变节点或输入框尺寸规则', () => {
    expect(indexCss).toMatch(
      /:is\(\.node-quick-editor, \.node-quick-editor-dialog\) \.node-quick-editor-controls\.node-quick-editor-topbar \{ align-items: start; display: grid; grid-template-columns: minmax\(0, 1fr\) auto; \}/,
    );
    expect(indexCss).toMatch(
      /\.node-quick-editor-settings \{ align-items: center; display: flex; flex-wrap: wrap; gap: 8px; min-width: 0; \}/,
    );
    expect(indexCss).toMatch(
      /\.node-quick-editor-settings > \.compact-select \{ flex: 1 1 100px; min-width: min\(100px, 100%\); \}/,
    );
    expect(indexCss).toMatch(
      /\.node-quick-editor-topbar > \.node-quick-editor-expand \{ grid-column: 2; grid-row: 1; \}/,
    );
  });

  it('快速编辑与 Dialog 的正文层只裁剪溢出，不再显示第二条滚动条', () => {
    expect(layoutCss).toMatch(
      /:is\(\.node-quick-editor, \.node-quick-editor-dialog\) \.node-quick-editor-prompt \.resource-mention-highlight \{ height: auto; max-height: none; min-height: 0; overflow: hidden; \}/,
    );
    expect(layoutCss.match(/\.resource-mention-highlight/g)).toHaveLength(1);
    expect(indexCss).toMatch(
      /\.resource-mention-highlight \{[^}]*bottom: 0;[^}]*position: absolute;[^}]*top: 0;/,
    );
  });
  it('底部 Skill、份数与生成整体靠右，排除顶部设置栏', () => {
    expect(layoutCss).toMatch(
      /:is\(\.node-quick-editor, \.node-quick-editor-dialog\) \.node-quick-editor-controls:not\(\.node-quick-editor-topbar\) \{ justify-content: flex-end; \}/,
    );
    expect(layoutCss.match(/justify-content: flex-end;/g)).toHaveLength(1);
    expect(editorCss).toMatch(
      /\.node-quick-editor-run-group \{[^}]*display: flex;[^}]*flex: 0 0 auto;/,
    );
  });

  it('快速编辑的纯文本和资源引用固定为 250px，父面板受限时不压缩提示词组', () => {
    expect(layoutCss).toMatch(
      /\.node-quick-editor \.node-quick-editor-prompt :is\(textarea, \.resource-mention-input\) \{ height: 250px; max-height: 250px; min-height: 250px; overflow-y: auto; resize: none; \}/,
    );
    expect(layoutCss).toMatch(
      /\.node-quick-editor \.node-quick-editor-prompt-group \{ flex: 0 0 auto; \}/,
    );
    expect(indexCss).not.toMatch(/\.node-quick-editor-prompt textarea \{/);
  });

  it('放大输入区固定为 60dvh，并为标题、资源和操作栏保留安全空间', () => {
    expect(editorCss).toMatch(
      /\.node-quick-editor-dialog \.node-quick-editor-prompt :is\(textarea, \.resource-mention-input\) \{ height: min\(60dvh, calc\(100dvh - 280px\)\); min-height: min\(60dvh, calc\(100dvh - 280px\)\); max-height: min\(60dvh, calc\(100dvh - 280px\)\); overflow-y: auto; resize: none;/,
    );
    expect(editorCss).not.toMatch(/\.node-quick-editor-field textarea \{[^}]*min-height:/);
  });

  it('纯文本与资源引用输入在鼠标或键盘聚焦时保持无边框和阴影', () => {
    expect(editorCss).toMatch(
      /:is\(\.node-quick-editor, \.node-quick-editor-dialog\) \.node-quick-editor-prompt :is\(textarea, \.resource-mention-input\), :is\(\.node-quick-editor, \.node-quick-editor-dialog\) \.node-quick-editor-prompt :is\(textarea, \.resource-mention-input\):is\(:focus, :focus-visible\) \{ border: 0 solid transparent; outline: none; box-shadow: none; \}/,
    );
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

  it('保留浮层定位，整体不滚动或裁剪底部控件', () => {
    expect(indexCss).toMatch(/\.quick-editor-overlay \{[^}]*position: fixed;/);
    expect(indexCss).toMatch(
      /\.quick-editor-overlay > \.node-quick-editor \{ overflow: visible; max-width: 100%; width: 100%; \}/,
    );
    expect(indexCss).not.toMatch(
      /\.quick-editor-overlay > \.node-quick-editor \{[^}]*overflow-y: auto;/,
    );
  });
});
