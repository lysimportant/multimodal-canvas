import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const assetNodeCss = readFileSync(resolve(process.cwd(), 'src/workspace/asset-node.css'), 'utf8');
const normalizedCss = assetNodeCss.replace(/\s+/g, ' ');

describe('asset node floating controls CSS contracts', () => {
  it('悬浮卡片在画布缩放后保持至少 250 个屏幕像素并允许超出节点', () => {
    expect(normalizedCss).toMatch(
      /\.flow-asset-node > \.flow-node-header\.flow-node-floating-controls \{[^}]*min-width: max\(250px, calc\(100% \* var\(--flow-node-zoom, 1\)\)\);/,
    );
    expect(normalizedCss).toContain('transform: scale(var(--flow-node-inverse-zoom, 1));');
    expect(normalizedCss).toContain('transform-origin: bottom left;');
    expect(normalizedCss).toContain('width: max-content;');
    expect(normalizedCss).toMatch(
      /\.flow-node-floating-controls \.flow-node-action-button \{[^}]*min-width: 28px;/,
    );
  });
});
