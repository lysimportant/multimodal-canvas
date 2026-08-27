import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const indexCss = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
const normalizedCss = indexCss.replace(/\s+/g, ' ');

describe('responsive UX CSS contracts', () => {
  it('locks the page scroll while any modal surface is open', () => {
    expect(normalizedCss).toMatch(
      /html:has\(\.project-hub-backdrop\), html:has\(\.command-palette-backdrop\), html:has\(\.project-create-backdrop\), html:has\(\.settings-backdrop\), body:has\(\.project-hub-backdrop\), body:has\(\.command-palette-backdrop\), body:has\(\.project-create-backdrop\), body:has\(\.settings-backdrop\) \{[^}]*overflow: hidden;/,
    );
    expect(normalizedCss).toMatch(
      /\.project-hub-backdrop, \.command-palette-backdrop, \.project-create-backdrop, \.settings-backdrop \{[^}]*overscroll-behavior: contain;/,
    );
  });

  it('keeps settings above its overlay as the only viewport-height scroll surface', () => {
    expect(normalizedCss).toMatch(
      /\.settings-backdrop \{[^}]*inset: 0;[^}]*position: fixed;[^}]*overscroll-behavior: contain;[^}]*z-index: 50;/,
    );
    expect(normalizedCss).toMatch(
      /\.settings-panel \{[^}]*height: 100dvh;[^}]*max-height: 100dvh;[^}]*max-width: 410px;[^}]*overscroll-behavior: contain;[^}]*overflow-x: hidden;[^}]*overflow-y: auto;[^}]*width: min\(100vw, 410px\);[^}]*z-index: 51;/,
    );
  });

  it('gives narrow headers a flexible action column', () => {
    expect(normalizedCss).toMatch(
      /@media \(max-width: 600px\)[\s\S]*?\.topbar \{[^}]*grid-template-columns: 40px minmax\(0, 1fr\);/,
    );
    expect(normalizedCss).toMatch(
      /@media \(max-width: 600px\)[\s\S]*?\.topbar-actions \{[^}]*grid-column: 2;[^}]*grid-row: 1;/,
    );
  });

  it('keeps narrow-screen notices in flow below the header', () => {
    expect(normalizedCss).toMatch(
      /@media \(max-width: 600px\)[\s\S]*?\.notice \{[^}]*left: auto;[^}]*margin: 0 16px 12px;[^}]*position: static;[^}]*top: auto;[^}]*transform: none;[^}]*width: calc\(100% - 32px\);/,
    );
  });

  it('overlays the transparent desktop header on the full-height canvas', () => {
    expect(normalizedCss).toMatch(
      /\.topbar \{[^}]*grid-template-columns: 260px minmax\(180px, 1fr\) max-content;[^}]*position: absolute;/,
    );
    expect(normalizedCss).toMatch(/\.workspace \{[^}]*height: 100vh;/);
    expect(normalizedCss).toMatch(/\.resource-panel, \.inspector-panel \{[^}]*padding: 86px/);
  });

  it('lets resized nodes grow their preview and removes the bottom palette while editing', () => {
    expect(normalizedCss).toMatch(
      /\.flow-asset-node \{[^}]*display: flex;[^}]*flex-direction: column;[^}]*height: 100%;/,
    );
    expect(normalizedCss).toMatch(/\.flow-node-preview \{[^}]*flex: 1 1 auto;/);
    expect(normalizedCss).toMatch(
      /\.canvas-area:has\(\.node-quick-editor\) \.canvas-node-tools \{[^}]*opacity: 0;[^}]*visibility: hidden;/,
    );
    expect(normalizedCss).toMatch(
      /\.canvas-area:has\(\.node-quick-editor\) \.react-flow__controls \{[^}]*opacity: 0;[^}]*pointer-events: none;[^}]*visibility: hidden;/,
    );
  });

  it('keeps the mobile node palette single-line and touch-scrollable', () => {
    expect(normalizedCss).toMatch(
      /@media \(max-width: 600px\)[\s\S]*?\.canvas-node-tools \{[^}]*flex-wrap: nowrap;[^}]*overflow-x: auto;[^}]*touch-action: pan-x;/,
    );
    expect(normalizedCss).toMatch(
      /@media \(max-width: 600px\)[\s\S]*?\.canvas-node-tools \{[^}]*left: 12px;[^}]*right: 56px;[^}]*transform: none;[^}]*width: auto;/,
    );
    expect(normalizedCss).toMatch(
      /@media \(max-width: 600px\)[\s\S]*?\.node-quick-toolbar \{[^}]*bottom: 16px !important;[^}]*left: 50% !important;[^}]*transform: translateX\(-50%\) !important;/,
    );
    expect(normalizedCss).toMatch(
      /@media \(max-width: 900px\)[\s\S]*?\.canvas-area:has\(\.node-quick-editor\) \{[^}]*flex-basis: 700px;[^}]*min-height: 700px;/,
    );
  });
});
