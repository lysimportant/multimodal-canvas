import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { DEFAULT_GENERATION_COUNT, isValidGenerationCount } from '@multimodal-canvas/domain';

import type { CanvasBackground } from '../workspace/contracts';
import type { CanvasEdgeEffect, CanvasEdgePathStyle } from '../workspace/canvas-edge-appearance';

export const CANVAS_BACKGROUND_KEY = 'multimodal-canvas:background';
export const CANVAS_THEME_KEY = 'multimodal-canvas:theme';
/**
 * 旧的单一连线偏好键。只用于迁移读取：新版本不再写入，
 * 但升级后仍按 `canvasEdgeStyleMigration` 映射出 `canvasEdgePathStyle` 与 `canvasEdgeEffect`。
 */
export const CANVAS_EDGE_STYLE_KEY = 'multimodal-canvas:edge-style';
export const CANVAS_EDGE_PATH_STYLE_KEY = 'multimodal-canvas:edge-path-style';
export const CANVAS_EDGE_EFFECT_KEY = 'multimodal-canvas:edge-effect';
/** 用户显式固定/收起的资源栏状态；只有抽屉版本标记有效时才恢复旧布尔值。 */
export const RESOURCE_PANEL_COLLAPSED_KEY = 'multimodal-canvas:resource-panel-collapsed';
/** 区分旧版默认展开和新版主动固定，未标记的浏览器统一启用紧凑抽屉。 */
export const RESOURCE_PANEL_DRAWER_VERSION_KEY = 'multimodal-canvas:resource-panel-drawer-version';
export const IMAGE_EDIT_SOURCE_CARD_KEY = 'multimodal-canvas:image-edit-source-card';
/** 仅用于删除已退役偏好，不恢复或写入自动生成状态。 */
export const AUTO_REVERSE_PROMPT_KEY = 'multimodal-canvas:auto-reverse-prompt';
/** 新建节点的默认生成数量，仅保存在当前浏览器，不追溯修改已有节点。 */
export const DEFAULT_GENERATION_COUNT_KEY = 'multimodal-canvas:default-generation-count';

const PERSISTENCE_KEY = 'multimodal-canvas:workspace-preferences';

export type CanvasTheme = 'eye-care' | 'light' | 'dark' | 'sepia' | 'contrast';

type PreferenceValues = {
  canvasBackground: CanvasBackground;
  canvasTheme: CanvasTheme;
  /** 连接线路径形态；与 `canvasEdgeEffect` 互相独立。 */
  canvasEdgePathStyle: CanvasEdgePathStyle;
  /** 连接线动态特效；切换特效不会改变路径几何。 */
  canvasEdgeEffect: CanvasEdgeEffect;
  /** true 为默认紧凑抽屉；false 为用户主动固定展开，不包含临时悬停状态。 */
  isResourcePanelCollapsed: boolean;
  /** 图片修改节点是否显示只读来源图卡片，默认显示。 */
  showImageEditSourceCard: boolean;
  /** 新建生成节点的数量，范围为 1 至 20；历史节点缺省仍按 1 份执行。 */
  defaultGenerationCount: number;
};

type ValueUpdater<T> = T | ((current: T) => T);

export type WorkspacePreferencesState = PreferenceValues & {
  setCanvasBackground: (background: CanvasBackground) => void;
  setCanvasTheme: (theme: CanvasTheme) => void;
  setCanvasEdgePathStyle: (pathStyle: CanvasEdgePathStyle) => void;
  setCanvasEdgeEffect: (effect: CanvasEdgeEffect) => void;
  setResourcePanelCollapsed: (collapsed: ValueUpdater<boolean>) => void;
  setShowImageEditSourceCard: (visible: ValueUpdater<boolean>) => void;
  /** 保存有效的默认数量；非法值抛出 RangeError，不修改当前偏好。 */
  setDefaultGenerationCount: (count: number) => void;
};

export const workspacePreferenceDefaults: PreferenceValues = {
  canvasBackground: 'dots',
  canvasTheme: 'eye-care',
  canvasEdgePathStyle: 'bezier',
  canvasEdgeEffect: 'meteor',
  isResourcePanelCollapsed: true,
  showImageEditSourceCard: true,
  defaultGenerationCount: DEFAULT_GENERATION_COUNT,
};

const canvasBackgrounds: CanvasBackground[] = ['dots', 'lines', 'cross', 'blank'];
const canvasThemes: CanvasTheme[] = ['eye-care', 'light', 'dark', 'sepia', 'contrast'];
const canvasEdgePathStyles: CanvasEdgePathStyle[] = [
  'bezier',
  'gentle',
  'smoothstep',
  'step',
  'straight',
];
const canvasEdgeEffects: CanvasEdgeEffect[] = [
  'meteor',
  'shooting-star',
  'marching',
  'cruiser',
  'multi',
  'breathe',
  'none',
];

/**
 * 旧单一偏好的显式迁移映射。
 *
 * - `flow` -> 标准曲线 + 流光（升级后与旧默认完全一致）；
 * - `pulse` -> 标准曲线 + 呼吸脉冲；
 * - `minimal` -> 标准曲线 + 无特效（升级不会强制开启动画）。
 */
export const canvasEdgeStyleMigration: Record<
  string,
  { canvasEdgePathStyle: CanvasEdgePathStyle; canvasEdgeEffect: CanvasEdgeEffect }
> = {
  flow: { canvasEdgePathStyle: 'bezier', canvasEdgeEffect: 'meteor' },
  pulse: { canvasEdgePathStyle: 'bezier', canvasEdgeEffect: 'breathe' },
  minimal: { canvasEdgePathStyle: 'bezier', canvasEdgeEffect: 'none' },
};

function browserStorage(): Storage | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function parsePreferences(storage: Storage): PreferenceValues | null {
  const rawBackground = storage.getItem(CANVAS_BACKGROUND_KEY);
  const rawTheme = storage.getItem(CANVAS_THEME_KEY);
  const rawPathStyle = storage.getItem(CANVAS_EDGE_PATH_STYLE_KEY);
  const rawEffect = storage.getItem(CANVAS_EDGE_EFFECT_KEY);
  const rawLegacyEdgeStyle = storage.getItem(CANVAS_EDGE_STYLE_KEY);
  const rawCollapsed = storage.getItem(RESOURCE_PANEL_COLLAPSED_KEY);
  const drawerVersion = storage.getItem(RESOURCE_PANEL_DRAWER_VERSION_KEY);
  const rawSourceCard = storage.getItem(IMAGE_EDIT_SOURCE_CARD_KEY);
  storage.removeItem(AUTO_REVERSE_PROMPT_KEY);
  const rawGenerationCount = storage.getItem(DEFAULT_GENERATION_COUNT_KEY);
  if (
    rawBackground === null &&
    rawTheme === null &&
    rawPathStyle === null &&
    rawEffect === null &&
    rawLegacyEdgeStyle === null &&
    rawCollapsed === null &&
    rawSourceCard === null &&
    rawGenerationCount === null
  )
    return null;

  // 新键优先；缺失的单个字段才回落到旧键迁移结果，最后才是默认值。
  const migrated =
    rawLegacyEdgeStyle === null ? undefined : canvasEdgeStyleMigration[rawLegacyEdgeStyle];

  return {
    canvasBackground: canvasBackgrounds.includes(rawBackground as CanvasBackground)
      ? (rawBackground as CanvasBackground)
      : workspacePreferenceDefaults.canvasBackground,
    canvasTheme: canvasThemes.includes(rawTheme as CanvasTheme)
      ? (rawTheme as CanvasTheme)
      : workspacePreferenceDefaults.canvasTheme,
    canvasEdgePathStyle: canvasEdgePathStyles.includes(rawPathStyle as CanvasEdgePathStyle)
      ? (rawPathStyle as CanvasEdgePathStyle)
      : (migrated?.canvasEdgePathStyle ?? workspacePreferenceDefaults.canvasEdgePathStyle),
    canvasEdgeEffect: canvasEdgeEffects.includes(rawEffect as CanvasEdgeEffect)
      ? (rawEffect as CanvasEdgeEffect)
      : (migrated?.canvasEdgeEffect ?? workspacePreferenceDefaults.canvasEdgeEffect),
    isResourcePanelCollapsed: drawerVersion !== '1' || rawCollapsed !== 'false',
    showImageEditSourceCard: rawSourceCard !== 'false',
    defaultGenerationCount: isValidGenerationCount(Number(rawGenerationCount))
      ? Number(rawGenerationCount)
      : workspacePreferenceDefaults.defaultGenerationCount,
  };
}

const preferenceStorage: StateStorage = {
  getItem: () => {
    const storage = browserStorage();
    if (!storage) return null;
    const state = parsePreferences(storage);
    return state ? JSON.stringify({ state, version: 0 }) : null;
  },
  setItem: (_name, value) => {
    const storage = browserStorage();
    if (!storage) return;
    try {
      const stored = JSON.parse(value) as { state?: Partial<PreferenceValues> };
      const state = { ...workspacePreferenceDefaults, ...stored.state };
      storage.setItem(CANVAS_BACKGROUND_KEY, state.canvasBackground);
      storage.setItem(CANVAS_THEME_KEY, state.canvasTheme);
      storage.setItem(CANVAS_EDGE_PATH_STYLE_KEY, state.canvasEdgePathStyle);
      storage.setItem(CANVAS_EDGE_EFFECT_KEY, state.canvasEdgeEffect);
      storage.removeItem(CANVAS_EDGE_STYLE_KEY);
      storage.setItem(RESOURCE_PANEL_COLLAPSED_KEY, String(state.isResourcePanelCollapsed));
      storage.setItem(RESOURCE_PANEL_DRAWER_VERSION_KEY, '1');
      storage.setItem(IMAGE_EDIT_SOURCE_CARD_KEY, String(state.showImageEditSourceCard));
      storage.removeItem(AUTO_REVERSE_PROMPT_KEY);
      storage.setItem(DEFAULT_GENERATION_COUNT_KEY, String(state.defaultGenerationCount));
    } catch {
      // Ignore malformed persistence writes; the in-memory preferences remain usable.
    }
  },
  removeItem: () => {
    const storage = browserStorage();
    storage?.removeItem(CANVAS_BACKGROUND_KEY);
    storage?.removeItem(CANVAS_THEME_KEY);
    storage?.removeItem(CANVAS_EDGE_PATH_STYLE_KEY);
    storage?.removeItem(CANVAS_EDGE_EFFECT_KEY);
    storage?.removeItem(CANVAS_EDGE_STYLE_KEY);
    storage?.removeItem(RESOURCE_PANEL_COLLAPSED_KEY);
    storage?.removeItem(RESOURCE_PANEL_DRAWER_VERSION_KEY);
    storage?.removeItem(IMAGE_EDIT_SOURCE_CARD_KEY);
    storage?.removeItem(AUTO_REVERSE_PROMPT_KEY);
    storage?.removeItem(DEFAULT_GENERATION_COUNT_KEY);
  },
};

export const useWorkspacePreferences = create<WorkspacePreferencesState>()(
  persist(
    (set) => ({
      ...workspacePreferenceDefaults,
      setCanvasBackground: (canvasBackground) => set({ canvasBackground }),
      setCanvasTheme: (canvasTheme) => set({ canvasTheme }),
      setCanvasEdgePathStyle: (canvasEdgePathStyle) => set({ canvasEdgePathStyle }),
      setCanvasEdgeEffect: (canvasEdgeEffect) => set({ canvasEdgeEffect }),
      setResourcePanelCollapsed: (collapsed) =>
        set((state) => ({
          isResourcePanelCollapsed:
            typeof collapsed === 'function' ? collapsed(state.isResourcePanelCollapsed) : collapsed,
        })),
      setShowImageEditSourceCard: (visible) =>
        set((state) => ({
          showImageEditSourceCard:
            typeof visible === 'function' ? visible(state.showImageEditSourceCard) : visible,
        })),
      setDefaultGenerationCount: (defaultGenerationCount) => {
        if (!isValidGenerationCount(defaultGenerationCount)) {
          throw new RangeError('默认生成数量必须为 1 至 20 的整数');
        }
        set({ defaultGenerationCount });
      },
    }),
    {
      name: PERSISTENCE_KEY,
      storage: createJSONStorage(() => preferenceStorage),
      partialize: ({
        canvasBackground,
        canvasTheme,
        canvasEdgePathStyle,
        canvasEdgeEffect,
        isResourcePanelCollapsed,
        showImageEditSourceCard,
        defaultGenerationCount,
      }) => ({
        canvasBackground,
        canvasTheme,
        canvasEdgePathStyle,
        canvasEdgeEffect,
        isResourcePanelCollapsed,
        showImageEditSourceCard,
        defaultGenerationCount,
      }),
    },
  ),
);
