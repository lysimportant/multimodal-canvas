import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const assetNodeCss = readFileSync(resolve(process.cwd(), 'src/workspace/asset-node.css'), 'utf8');
const normalizedCss = assetNodeCss.replace(/\s+/g, ' ');

describe('asset node floating controls CSS contracts', () => {
  it('悬浮卡片随图标和文字收缩，不左右分栏且始终显示功能简述', () => {
    expect(normalizedCss).toMatch(
      /\.flow-asset-node > \.flow-node-header\.flow-node-floating-controls \{[^}]*min-width: calc\(100% \* var\(--flow-node-zoom, 1\)\);/,
    );
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
    expect(normalizedCss).toMatch(
      /\.flow-node-floating-controls \.flow-node-action-button \{[^}]*min-width: 28px;/,
    );
    expect(normalizedCss).toMatch(/\.flow-node-action-label \{[^}]*display: inline;/);
  });
});
