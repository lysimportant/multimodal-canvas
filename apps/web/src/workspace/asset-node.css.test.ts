import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const assetNodeCss = readFileSync(resolve(process.cwd(), 'src/workspace/asset-node.css'), 'utf8');
const normalizedCss = assetNodeCss.replace(/\s+/g, ' ');

describe('asset node floating controls CSS contracts', () => {
  it('keeps the node hover card wide enough for its controls', () => {
    expect(normalizedCss).toMatch(
      /\.flow-asset-node > \.flow-node-header\.flow-node-floating-controls \{[^}]*min-width: 250px;/,
    );
  });
});
