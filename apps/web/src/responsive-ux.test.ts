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
    expect(normalizedCss).toMatch(/\.save-state \{[^}]*white-space: nowrap;/);
    expect(normalizedCss).toMatch(
      /@media \(max-width: 600px\)[\s\S]*?\.save-state-label \{[^}]*display: none;/,
    );
    expect(normalizedCss).toMatch(
      /@media \(max-width: 900px\)[\s\S]*?\.project-context:has\(\.project-menu\) \{[^}]*overflow: visible;/,
    );
    expect(normalizedCss).toMatch(
      /@media \(max-width: 900px\)[\s\S]*?\.project-menu \{[^}]*max-width: calc\(100vw - 68px\);[^}]*min-width: 0;[^}]*width: min\(280px, calc\(100vw - 68px\)\);/,
    );
    expect(normalizedCss).toMatch(
      /@media \(max-width: 600px\)[\s\S]*?\.topbar-actions \{[^}]*justify-content: flex-start;[^}]*max-width: 100%;[^}]*overflow: visible;/,
    );
    expect(normalizedCss).toMatch(
      /@media \(max-width: 600px\)[\s\S]*?\.topbar-tool-cluster \{[^}]*flex: 0 1 auto;[^}]*max-width: 100%;[^}]*overflow-x: auto;/,
    );
    expect(normalizedCss).toMatch(
      /@media \(max-width: 600px\)[\s\S]*?\.topbar-resource-filter \{[^}]*box-sizing: border-box;[^}]*flex: 0 0 min\(132px, 100%\);[^}]*max-width: 100%;[^}]*overflow: hidden;/,
    );
    expect(normalizedCss).toMatch(
      /@media \(max-width: 600px\)[\s\S]*?\.topbar-resource-filter select \{[^}]*flex: 1 1 0;[^}]*min-width: 0;[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;[^}]*width: 0;/,
    );
    const finalCanvasChromeCss = normalizedCss.slice(
      normalizedCss.lastIndexOf('/* Canvas chrome:'),
    );
    expect(finalCanvasChromeCss).toMatch(
      /@media \(max-width: 600px\)[\s\S]*?\.topbar \{[^}]*grid-template-columns: 40px minmax\(0, 1fr\);/,
    );
    expect(finalCanvasChromeCss).toMatch(
      /@media \(max-width: 600px\)[\s\S]*?\.topbar-actions \{[^}]*grid-column: 2;[^}]*grid-row: 1;/,
    );
    expect(finalCanvasChromeCss).toMatch(
      /\.topbar-resource-filter:focus-within \{[^}]*border-color: var\(--mc-accent\);[^}]*box-shadow: 0 0 0 3px var\(--mc-focus\);/,
    );
    expect(finalCanvasChromeCss).toMatch(
      /\.topbar-tool-cluster:focus-within \{[^}]*border-color: var\(--mc-accent\);[^}]*box-shadow: 0 0 0 3px var\(--mc-focus\);/,
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

  it('keeps previews inside user-sized nodes and removes the bottom palette while editing', () => {
    expect(normalizedCss).toMatch(
      /\.flow-asset-node \{[^}]*display: flex;[^}]*flex-direction: column;[^}]*height: 100%;/,
    );
    expect(normalizedCss).toMatch(/\.flow-node-preview \{[^}]*flex: 1 1 0;[^}]*min-height: 0;/);
    expect(normalizedCss).toMatch(/\.flow-node-preview \{[^}]*contain: layout paint;/);
    expect(normalizedCss).toMatch(
      /\.canvas-area:has\(\.node-quick-editor\) \.canvas-node-tools \{[^}]*opacity: 0;[^}]*visibility: hidden;/,
    );
    expect(normalizedCss).toMatch(
      /\.canvas-area:has\(\.node-quick-editor\) \.react-flow__controls \{[^}]*opacity: 0;[^}]*pointer-events: none;[^}]*visibility: hidden;/,
    );
    expect(normalizedCss).toMatch(
      /\.canvas-area\.has-quick-editor \.canvas-node-tools \{[^}]*opacity: 0;[^}]*visibility: hidden;/,
    );
    expect(normalizedCss).toMatch(
      /\.canvas-area\.has-quick-editor \.react-flow__controls \{[^}]*opacity: 0;[^}]*pointer-events: none;[^}]*visibility: hidden;/,
    );
  });

  it('keeps the top editing controls on one visual layer', () => {
    expect(normalizedCss).toMatch(
      /\.topbar-tool-cluster,[\s\S]*?\.topbar-background-picker,[\s\S]*?box-shadow: none;/,
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

  it('lays out media parameter groups by media type and keeps edge popovers above the canvas', () => {
    expect(normalizedCss).toMatch(
      /\.node-quick-editor-media-options \{[^}]*display: grid;[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/,
    );
    expect(normalizedCss).toMatch(
      /\.node-quick-editor-media-options\[data-columns='2'\] \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/,
    );
    expect(normalizedCss).toMatch(
      /\.node-quick-editor-option-popover \{[^}]*min-width: min\(300px, calc\(100vw - 32px\)\);[^}]*width: min\(330px, calc\(100vw - 32px\)\);/,
    );
    expect(normalizedCss).toMatch(
      /\.node-quick-editor-option-group:hover \.node-quick-editor-option-popover, \.node-quick-editor-option-group:focus-within \.node-quick-editor-option-popover, \.node-quick-editor-option-group\[data-open='true'\] \.node-quick-editor-option-popover \{[^}]*display: grid;[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/,
    );
    expect(normalizedCss).toMatch(
      /\.node-quick-editor-option \{[^}]*display: flex;[^}]*flex-direction: column;[^}]*text-align: center;/,
    );
    expect(normalizedCss).toMatch(
      /\.node-quick-editor-option-group\[data-placement='top'\] \.node-quick-editor-option-popover \{[^}]*bottom: calc\(100% \+ 6px\);[^}]*top: auto;/,
    );
    expect(normalizedCss).toMatch(
      /\.node-quick-editor-media-options\[data-columns='2'\][\s\S]*?\.node-quick-editor-option-group:nth-child\(2\)[\s\S]*?\.node-quick-editor-option-popover \{[^}]*left: auto;[^}]*right: 0;[^}]*transform: none;/,
    );
  });

  it('keeps mobile chrome bounded while preserving local horizontal scrolling', () => {
    expect(normalizedCss).toMatch(
      /@media \(max-width: 600px\)[\s\S]*?\.topbar-actions \{[^}]*max-width: 100%;[^}]*overflow: visible;/,
    );
    expect(normalizedCss).toMatch(
      /@media \(max-width: 600px\)[\s\S]*?\.topbar-actions, \.topbar-tool-cluster, \.topbar-resource-filter \{[^}]*min-width: 0;/,
    );
    expect(normalizedCss).toMatch(
      /@media \(max-width: 600px\)[\s\S]*?\.topbar-tool-cluster \{[^}]*flex: 0 1 auto;[^}]*max-width: 100%;[^}]*overflow-x: auto;[^}]*overflow-y: hidden;/,
    );
    expect(normalizedCss).toMatch(
      /@media \(max-width: 600px\)[\s\S]*?\.topbar-resource-filter \{[^}]*box-sizing: border-box;[^}]*flex: 0 0 min\(132px, 100%\);[^}]*max-width: 100%;[^}]*overflow: hidden;/,
    );
    expect(normalizedCss).toMatch(
      /@media \(max-width: 600px\)[\s\S]*?\.canvas-node-tools \{[^}]*left: 12px;[^}]*overflow-x: auto;[^}]*right: 56px;[^}]*width: auto;/,
    );
    expect(normalizedCss).toMatch(
      /@media \(max-width: 600px\)[\s\S]*?\.topbar-actions \{[^}]*width: 100%;/,
    );
    expect(normalizedCss).toMatch(
      /@media \(max-width: 600px\)[\s\S]*?\.topbar-tool-cluster \{[^}]*flex: 1 1 auto;[^}]*width: 100%;/,
    );
    expect(normalizedCss).toMatch(
      /@media \(max-width: 600px\)[\s\S]*?\.topbar-tool-cluster > \*,[^}]*flex: 0 0 auto;/,
    );
  });

  it('wraps the resource filter within the 320px header width', () => {
    expect(normalizedCss).toMatch(
      /@media \(max-width: 340px\)[\s\S]*?\.project-context \{[^}]*align-content: flex-start;[^}]*flex-wrap: wrap;[^}]*overflow-x: visible;/,
    );
    expect(normalizedCss).toMatch(
      /@media \(max-width: 340px\)[\s\S]*?\.topbar-resource-filter \{[^}]*flex: 1 1 calc\(100% - 12px\);[^}]*width: calc\(100% - 12px\);/,
    );
    expect(normalizedCss).toMatch(
      /@media \(max-width: 340px\)[\s\S]*?\.topbar-tool-cluster \{[^}]*gap: 0;[^}]*padding: 1px;/,
    );
    expect(normalizedCss).toMatch(
      /@media \(max-width: 340px\)[\s\S]*?\.topbar-tool-divider \{[^}]*margin-inline: 0;/,
    );
    expect(normalizedCss).toMatch(
      /@media \(max-width: 340px\)[\s\S]*?\.topbar \{[^}]*grid-template-columns: minmax\(0, 1fr\);/,
    );
    expect(normalizedCss).toMatch(
      /@media \(max-width: 340px\)[\s\S]*?\.topbar-actions \{[^}]*grid-column: 1;/,
    );
    expect(normalizedCss).toMatch(
      /@media \(max-width: 340px\)[\s\S]*?\.canvas-node-tools \{[^}]*left: 8px;[^}]*right: 44px;[^}]*scroll-padding-inline: 6px;/,
    );
    expect(normalizedCss).toMatch(
      /@media \(max-width: 340px\)[\s\S]*?\.canvas-node-tools \.canvas-node-tool,[^}]*\.canvas-node-tools \.canvas-node-tool-transform \{[^}]*flex: 0 0 36px;[^}]*height: 36px;[^}]*width: 36px;/,
    );
  });

  it('makes selected animated edges visibly stronger and faster', () => {
    expect(normalizedCss).toMatch(
      /\.react-flow__edge\.selected \.react-flow__edge-path \{[^}]*stroke: var\(--mc-accent-strong\) !important;[^}]*stroke-width: 4px !important;/,
    );
    expect(normalizedCss).toMatch(
      /\.react-flow__edge\.selected\.animated \.react-flow__edge-path \{[^}]*animation-duration: 0\.2s !important;/,
    );
  });

  it('keeps final mobile bounds local to the viewport', () => {
    const finalMobileCss = normalizedCss.slice(
      normalizedCss.lastIndexOf('/* Final mobile bounds:'),
    );
    expect(normalizedCss).toMatch(
      /@media \(max-width: 600px\)[\s\S]*?\.project-context \{[^}]*flex-wrap: wrap;[^}]*overflow-x: visible;/,
    );
    expect(finalMobileCss).toMatch(
      /@media \(max-width: 600px\)[\s\S]*?\.topbar,[\s\S]*?\.topbar-resource-filter \{[^}]*max-width: 100%;[^}]*min-width: 0;/,
    );
    expect(finalMobileCss).toMatch(
      /\.topbar-tool-cluster \{[^}]*overflow-x: auto;[^}]*overflow-y: hidden;/,
    );
    expect(finalMobileCss).toMatch(
      /\.canvas-node-tools \{[^}]*box-sizing: border-box;[^}]*max-width: calc\(100% - 52px\);[^}]*min-width: 0;/,
    );
    expect(finalMobileCss).toMatch(
      /\.canvas-node-tools \.canvas-node-tool,[\s\S]*?\.canvas-node-tools \.canvas-node-tool-transform \{[^}]*flex: 0 0 36px;/,
    );
  });
});
