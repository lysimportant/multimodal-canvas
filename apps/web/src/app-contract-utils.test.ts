import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PROJECT_NAME,
  SUCCESS_NOTICE_DISMISS_MS,
  canSwitchProject,
  createGenerateFlowNode,
  createSourceFlowNode,
  findProject,
  getNoticeAutoDismissMs,
  normalizeProjectName,
  parseCanvasBackground,
  type ProjectSummary,
} from './app-contract-utils';

const asset = {
  id: 'asset-image-1',
  name: 'reference.png',
  mediaType: 'image' as const,
  mimeType: 'image/png',
  contentUrl: '/v1/assets/asset-image-1/content',
};

const projects: ProjectSummary[] = [
  {
    id: 'project-a',
    name: 'Storyboard',
    createdAt: '2026-08-25T00:00:00.000Z',
    updatedAt: '2026-08-25T00:01:00.000Z',
  },
  {
    id: 'project-b',
    name: 'Product shots',
    createdAt: '2026-08-25T00:00:00.000Z',
    updatedAt: '2026-08-25T00:02:00.000Z',
  },
];

describe('canvas node factories', () => {
  it('creates a source node with asset references and stable position', () => {
    const node = createSourceFlowNode(asset, { x: 24, y: 48 }, () => 'fixed');

    expect(node).toMatchObject({
      id: 'node_asset-image-1_fixed',
      type: 'image',
      position: { x: 24, y: 48 },
      data: {
        label: 'reference.png',
        mediaType: 'image',
        mode: 'source',
        assetId: 'asset-image-1',
        contentUrl: '/v1/assets/asset-image-1/content',
        mimeType: 'image/png',
      },
    });
  });

  it('creates every generate node with the expected mode without a fabricated strength', () => {
    const node = createGenerateFlowNode('video', { x: 100, y: 120 }, () => 'fixed');

    expect(node).toMatchObject({
      id: 'node_video_fixed',
      type: 'video',
      position: { x: 100, y: 120 },
      data: {
        label: '视频生成节点',
        mediaType: 'video',
        mode: 'generate',
      },
    });
  });
});

describe('project and canvas UI contracts', () => {
  it('normalizes blank project names and preserves meaningful names', () => {
    expect(normalizeProjectName('  ')).toBe(DEFAULT_PROJECT_NAME);
    expect(normalizeProjectName('  Product shots  ')).toBe('Product shots');
  });

  it('parses known backgrounds and falls back for stale local storage', () => {
    expect(parseCanvasBackground('cross')).toBe('cross');
    expect(parseCanvasBackground(null)).toBe('dots');
    expect(parseCanvasBackground('unknown')).toBe('dots');
  });

  it('selects a project by id and rejects missing projects', () => {
    expect(findProject(projects, 'project-b')).toEqual(projects[1]);
    expect(findProject(projects, 'missing')).toBeUndefined();
    expect(findProject(projects, null)).toBeUndefined();
  });

  it('blocks duplicate and concurrent project switches', () => {
    expect(canSwitchProject('project-a', 'project-a', false)).toBe(false);
    expect(canSwitchProject('project-a', 'project-b', true)).toBe(false);
    expect(canSwitchProject('project-a', 'project-b', false)).toBe(true);
  });
});

describe('notice lifecycle contract', () => {
  it('auto-dismisses success notices but keeps errors visible', () => {
    expect(getNoticeAutoDismissMs({ kind: 'success', message: 'saved' })).toBe(
      SUCCESS_NOTICE_DISMISS_MS,
    );
    expect(getNoticeAutoDismissMs({ kind: 'error', message: 'failed' })).toBeNull();
    expect(getNoticeAutoDismissMs(null)).toBeNull();
  });
});
