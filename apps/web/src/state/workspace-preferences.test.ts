import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CANVAS_BACKGROUND_KEY,
  CANVAS_EDGE_EFFECT_KEY,
  CANVAS_EDGE_PATH_STYLE_KEY,
  CANVAS_EDGE_STYLE_KEY,
  CANVAS_THEME_KEY,
  IMAGE_EDIT_SOURCE_CARD_KEY,
  RESOURCE_PANEL_COLLAPSED_KEY,
  canvasEdgeStyleMigration,
  useWorkspacePreferences,
  workspacePreferenceDefaults,
} from './workspace-preferences';

describe('连线偏好默认值', () => {
  it('默认标准曲线加流光', () => {
    expect(workspacePreferenceDefaults.canvasEdgePathStyle).toBe('bezier');
    expect(workspacePreferenceDefaults.canvasEdgeEffect).toBe('meteor');
  });
});

describe('workspace preferences store', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useWorkspacePreferences.setState(workspacePreferenceDefaults);
    window.localStorage.clear();
  });

  afterEach(() => {
    useWorkspacePreferences.setState(workspacePreferenceDefaults);
    window.localStorage.clear();
  });

  it('persists theme, background, edge path, edge effect and resource panel state under stable keys', () => {
    const state = useWorkspacePreferences.getState();
    state.setCanvasTheme('dark');
    state.setCanvasBackground('blank');
    state.setCanvasEdgePathStyle('smoothstep');
    state.setCanvasEdgeEffect('cruiser');
    state.setResourcePanelCollapsed(true);
    state.setShowImageEditSourceCard(false);

    expect(window.localStorage.getItem(CANVAS_THEME_KEY)).toBe('dark');
    expect(window.localStorage.getItem(CANVAS_BACKGROUND_KEY)).toBe('blank');
    expect(window.localStorage.getItem(CANVAS_EDGE_PATH_STYLE_KEY)).toBe('smoothstep');
    expect(window.localStorage.getItem(CANVAS_EDGE_EFFECT_KEY)).toBe('cruiser');
    expect(window.localStorage.getItem(RESOURCE_PANEL_COLLAPSED_KEY)).toBe('true');
    expect(window.localStorage.getItem(IMAGE_EDIT_SOURCE_CARD_KEY)).toBe('false');
    // 迁移完成后旧键不再写入。
    expect(window.localStorage.getItem(CANVAS_EDGE_STYLE_KEY)).toBeNull();
  });

  it('切路径形态不会重置特效，切特效也不会重置路径形态', () => {
    const state = useWorkspacePreferences.getState();
    state.setCanvasEdgeEffect('multi');
    state.setCanvasEdgePathStyle('straight');

    expect(useWorkspacePreferences.getState()).toMatchObject({
      canvasEdgePathStyle: 'straight',
      canvasEdgeEffect: 'multi',
    });

    state.setCanvasEdgePathStyle('step');
    expect(useWorkspacePreferences.getState().canvasEdgeEffect).toBe('multi');
    state.setCanvasEdgeEffect('none');
    expect(useWorkspacePreferences.getState().canvasEdgePathStyle).toBe('step');
  });

  it('rehydrates persisted values and rejects unsupported appearance values', async () => {
    window.localStorage.setItem(CANVAS_THEME_KEY, 'unsupported');
    window.localStorage.setItem(CANVAS_BACKGROUND_KEY, 'lines');
    window.localStorage.setItem(RESOURCE_PANEL_COLLAPSED_KEY, 'true');
    window.localStorage.setItem(CANVAS_EDGE_PATH_STYLE_KEY, 'unsupported');
    window.localStorage.setItem(CANVAS_EDGE_EFFECT_KEY, 'unsupported');

    await useWorkspacePreferences.persist.rehydrate();

    expect(useWorkspacePreferences.getState()).toMatchObject({
      canvasTheme: 'eye-care',
      canvasBackground: 'lines',
      canvasEdgePathStyle: 'bezier',
      canvasEdgeEffect: 'meteor',
      isResourcePanelCollapsed: true,
      showImageEditSourceCard: true,
    });
  });

  it('无效旧偏好回退到默认值', async () => {
    window.localStorage.setItem(CANVAS_EDGE_STYLE_KEY, 'unsupported');

    await useWorkspacePreferences.persist.rehydrate();

    expect(useWorkspacePreferences.getState()).toMatchObject({
      canvasEdgePathStyle: 'bezier',
      canvasEdgeEffect: 'meteor',
    });
  });

  it.each([
    ['flow', 'bezier', 'meteor'],
    ['pulse', 'bezier', 'breathe'],
    ['minimal', 'bezier', 'none'],
  ] as const)('旧偏好 %s 迁移为 %s + %s', async (legacy, pathStyle, effect) => {
    window.localStorage.setItem(CANVAS_EDGE_STYLE_KEY, legacy);

    await useWorkspacePreferences.persist.rehydrate();

    expect(useWorkspacePreferences.getState()).toMatchObject({
      canvasEdgePathStyle: pathStyle,
      canvasEdgeEffect: effect,
    });
    expect(canvasEdgeStyleMigration[legacy]).toEqual({
      canvasEdgePathStyle: pathStyle,
      canvasEdgeEffect: effect,
    });
  });

  it('新键优先于旧键，只在缺失时读取旧偏好', async () => {
    window.localStorage.setItem(CANVAS_EDGE_STYLE_KEY, 'pulse');
    window.localStorage.setItem(CANVAS_EDGE_PATH_STYLE_KEY, 'straight');

    await useWorkspacePreferences.persist.rehydrate();

    // 路径来自新键，特效仍回落到旧键迁移结果。
    expect(useWorkspacePreferences.getState()).toMatchObject({
      canvasEdgePathStyle: 'straight',
      canvasEdgeEffect: 'breathe',
    });
  });

  it('写入后会清理旧偏好键', async () => {
    window.localStorage.setItem(CANVAS_EDGE_STYLE_KEY, 'minimal');
    await useWorkspacePreferences.persist.rehydrate();
    expect(window.localStorage.getItem(CANVAS_EDGE_STYLE_KEY)).toBe('minimal');

    useWorkspacePreferences.getState().setCanvasEdgeEffect('multi');

    expect(window.localStorage.getItem(CANVAS_EDGE_STYLE_KEY)).toBeNull();
    expect(window.localStorage.getItem(CANVAS_EDGE_EFFECT_KEY)).toBe('multi');
  });
});
