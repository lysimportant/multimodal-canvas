import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AUTO_REVERSE_PROMPT_KEY,
  CANVAS_BACKGROUND_KEY,
  CANVAS_EDGE_EFFECT_KEY,
  CANVAS_EDGE_PATH_STYLE_KEY,
  CANVAS_EDGE_STYLE_KEY,
  CANVAS_THEME_KEY,
  DEFAULT_GENERATION_COUNT_KEY,
  IMAGE_EDIT_SOURCE_CARD_KEY,
  RESOURCE_PANEL_COLLAPSED_KEY,
  RESOURCE_PANEL_DRAWER_VERSION_KEY,
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

  it('资源栏默认紧凑，首次加载没有持久偏好也不会固定展开', async () => {
    expect(workspacePreferenceDefaults.isResourcePanelCollapsed).toBe(true);
    await useWorkspacePreferences.persist.rehydrate();
    expect(useWorkspacePreferences.getState().isResourcePanelCollapsed).toBe(true);
  });

  it.each(['false', 'true', 'invalid'])(
    '旧版折叠值 %s 升级为紧凑抽屉，保留其他偏好',
    async (legacy) => {
      window.localStorage.setItem(RESOURCE_PANEL_COLLAPSED_KEY, legacy);
      window.localStorage.setItem(CANVAS_THEME_KEY, 'dark');
      window.localStorage.setItem(CANVAS_EDGE_EFFECT_KEY, 'none');
      window.localStorage.setItem(DEFAULT_GENERATION_COUNT_KEY, '3');
      await useWorkspacePreferences.persist.rehydrate();
      expect(useWorkspacePreferences.getState()).toMatchObject({
        isResourcePanelCollapsed: true,
        canvasTheme: 'dark',
        canvasEdgeEffect: 'none',
        defaultGenerationCount: 3,
      });
    },
  );

  it('新版显式固定会保存版本标记，刷新保留固定；再次收起也可恢复', async () => {
    useWorkspacePreferences.getState().setResourcePanelCollapsed(false);
    expect(window.localStorage.getItem(RESOURCE_PANEL_COLLAPSED_KEY)).toBe('false');
    expect(window.localStorage.getItem(RESOURCE_PANEL_DRAWER_VERSION_KEY)).toBe('1');
    await useWorkspacePreferences.persist.rehydrate();
    expect(useWorkspacePreferences.getState().isResourcePanelCollapsed).toBe(false);
    useWorkspacePreferences.getState().setResourcePanelCollapsed((collapsed) => !collapsed);
    await useWorkspacePreferences.persist.rehydrate();
    expect(useWorkspacePreferences.getState().isResourcePanelCollapsed).toBe(true);
  });

  it('迁移后修改无关偏好不会把旧默认展开重新固定', async () => {
    window.localStorage.setItem(RESOURCE_PANEL_COLLAPSED_KEY, 'false');
    await useWorkspacePreferences.persist.rehydrate();
    useWorkspacePreferences.getState().setCanvasTheme('sepia');
    expect(window.localStorage.getItem(RESOURCE_PANEL_DRAWER_VERSION_KEY)).toBe('1');
    await useWorkspacePreferences.persist.rehydrate();
    expect(useWorkspacePreferences.getState().isResourcePanelCollapsed).toBe(true);
    expect(useWorkspacePreferences.getState().canvasTheme).toBe('sepia');
  });

  it.each([
    ['1', 'invalid'],
    ['unknown', 'false'],
  ])('异常抽屉版本/值 %s/%s 安全回退到紧凑模式', async (version, collapsed) => {
    window.localStorage.setItem(RESOURCE_PANEL_DRAWER_VERSION_KEY, version);
    window.localStorage.setItem(RESOURCE_PANEL_COLLAPSED_KEY, collapsed);
    await useWorkspacePreferences.persist.rehydrate();
    expect(useWorkspacePreferences.getState().isResourcePanelCollapsed).toBe(true);
  });

  it('清除偏好也删除抽屉版本标记，不影响下一次紧凑默认', async () => {
    useWorkspacePreferences.getState().setResourcePanelCollapsed(false);
    await useWorkspacePreferences.persist.clearStorage();
    expect(window.localStorage.getItem(RESOURCE_PANEL_COLLAPSED_KEY)).toBeNull();
    expect(window.localStorage.getItem(RESOURCE_PANEL_DRAWER_VERSION_KEY)).toBeNull();
  });

  it('默认生成一份，显式数量可以持久化恢复', async () => {
    expect(useWorkspacePreferences.getState().defaultGenerationCount).toBe(1);
    useWorkspacePreferences.getState().setDefaultGenerationCount(3);
    expect(window.localStorage.getItem(DEFAULT_GENERATION_COUNT_KEY)).toBe('3');
    await useWorkspacePreferences.persist.rehydrate();
    expect(useWorkspacePreferences.getState().defaultGenerationCount).toBe(3);
  });

  it.each(['0', '-1', '1.5', '21', 'NaN', ''])('非法数量偏好 %s 恢复为一份', async (value) => {
    window.localStorage.setItem(DEFAULT_GENERATION_COUNT_KEY, value);
    await useWorkspacePreferences.persist.rehydrate();
    expect(useWorkspacePreferences.getState().defaultGenerationCount).toBe(1);
  });

  it('拒绝写入非法默认数量，保留之前的偏好', () => {
    useWorkspacePreferences.getState().setDefaultGenerationCount(3);
    expect(() => useWorkspacePreferences.getState().setDefaultGenerationCount(0)).toThrow(
      RangeError,
    );
    expect(useWorkspacePreferences.getState().defaultGenerationCount).toBe(3);
    expect(window.localStorage.getItem(DEFAULT_GENERATION_COUNT_KEY)).toBe('3');
  });

  it('旧自动反推偏好不能恢复或触发调用', async () => {
    expect(useWorkspacePreferences.getState()).not.toHaveProperty('autoReversePrompt');
    window.localStorage.setItem(AUTO_REVERSE_PROMPT_KEY, 'yes');
    await useWorkspacePreferences.persist.rehydrate();
    expect(useWorkspacePreferences.getState()).not.toHaveProperty('autoReversePrompt');
    expect(window.localStorage.getItem(AUTO_REVERSE_PROMPT_KEY)).toBeNull();
    await useWorkspacePreferences.persist.rehydrate();
    expect(useWorkspacePreferences.getState()).not.toHaveProperty('setAutoReversePrompt');
    expect(window.localStorage.getItem(AUTO_REVERSE_PROMPT_KEY)).toBeNull();
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

  it.each(['meteor', 'shooting-star', 'marching', 'cruiser', 'multi', 'breathe', 'none'] as const)(
    '保存并重新读取特效 %s，保留独立路径偏好',
    async (effect) => {
      useWorkspacePreferences.getState().setCanvasEdgePathStyle('straight');
      useWorkspacePreferences.getState().setCanvasEdgeEffect(effect);
      expect(window.localStorage.getItem(CANVAS_EDGE_EFFECT_KEY)).toBe(effect);
      await useWorkspacePreferences.persist.rehydrate();
      expect(useWorkspacePreferences.getState()).toMatchObject({
        canvasEdgeEffect: effect,
        canvasEdgePathStyle: 'straight',
      });
    },
  );

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
