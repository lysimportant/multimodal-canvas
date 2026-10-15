import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** jsdom 不计算实际布局；此处只锁定复刻弹窗的尺寸与滚动 CSS 契约。 */
const layoutCss = readFileSync(
  resolve(process.cwd(), 'src/workspace/node-quick-editor-layout.css'),
  'utf8',
).replace(/\s+/g, ' ');

describe('短视频复刻弹窗布局', () => {
  it('桌面占约四分之三视口，三栏各自保留滚动边界', () => {
    const dialogRule = layoutCss.match(
      /\.node-quick-editor-dialog\.node-quick-editor-recreation-dialog \{([^}]*)\}/,
    )?.[1];
    expect(dialogRule).toContain('width: min(75vw, calc(100vw - 32px));');
    expect(dialogRule).toContain('height: min(75dvh, calc(100dvh - 32px));');
    expect(dialogRule).toContain('overflow: hidden;');

    const bodyRule = layoutCss.match(
      /\.node-quick-editor-dialog-body\.node-quick-editor-recreation-body \{([^}]*)\}/,
    )?.[1];
    expect(bodyRule).toContain('grid-template-columns: repeat(3, minmax(0, 1fr));');
    expect(bodyRule).toContain('min-height: 0;');
    expect(bodyRule).toContain('overflow: hidden;');
    expect(layoutCss).toMatch(
      /\.node-quick-editor-recreation-source, \.node-quick-editor-recreation-pending, \.node-quick-editor-recreation-generate \{[^}]*overflow-y: auto;/,
    );
    expect(layoutCss).toMatch(
      /\.ant-modal-wrap\.ant-modal-centered:has\(\.node-quick-editor-dialog\) \{[^}]*overflow: hidden;/,
    );
  });

  it('窄视口退回到视口内宽度', () => {
    expect(layoutCss).toMatch(
      /@media \(max-width: 980px\) \{ \.node-quick-editor-dialog\.node-quick-editor-recreation-dialog \{ width: calc\(100vw - 32px\); \}/,
    );
  });
});
