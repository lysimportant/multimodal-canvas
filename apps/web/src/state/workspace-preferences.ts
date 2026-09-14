import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';

import type { CanvasBackground } from '../workspace/contracts';

export const CANVAS_BACKGROUND_KEY = 'multimodal-canvas:background';
export const CANVAS_THEME_KEY = 'multimodal-canvas:theme';
export const CANVAS_EDGE_STYLE_KEY = 'multimodal-canvas:edge-style';
export const RESOURCE_PANEL_COLLAPSED_KEY = 'multimodal-canvas:resource-panel-collapsed';

const PERSISTENCE_KEY = 'multimodal-canvas:workspace-preferences';

export type CanvasTheme = 'eye-care' | 'light' | 'dark' | 'sepia' | 'contrast';
/** 画布连线视觉模式；只影响展示，不写入画布文档。 */
export type CanvasEdgeStyle = 'flow' | 'pulse' | 'minimal';

type PreferenceValues = {
  canvasBackground: CanvasBackground;
  canvasTheme: CanvasTheme;
  canvasEdgeStyle: CanvasEdgeStyle;
  isResourcePanelCollapsed: boolean;
};

type ValueUpdater<T> = T | ((current: T) => T);

export type WorkspacePreferencesState = PreferenceValues & {
  setCanvasBackground: (background: CanvasBackground) => void;
  setCanvasTheme: (theme: CanvasTheme) => void;
  setCanvasEdgeStyle: (style: CanvasEdgeStyle) => void;
  setResourcePanelCollapsed: (collapsed: ValueUpdater<boolean>) => void;
};

export const workspacePreferenceDefaults: PreferenceValues = {
  canvasBackground: 'dots',
  canvasTheme: 'eye-care',
  canvasEdgeStyle: 'flow',
  isResourcePanelCollapsed: false,
};

const canvasBackgrounds: CanvasBackground[] = ['dots', 'lines', 'cross', 'blank'];
const canvasThemes: CanvasTheme[] = ['eye-care', 'light', 'dark', 'sepia', 'contrast'];
const canvasEdgeStyles: CanvasEdgeStyle[] = ['flow', 'pulse', 'minimal'];

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
  const rawEdgeStyle = storage.getItem(CANVAS_EDGE_STYLE_KEY);
  const rawCollapsed = storage.getItem(RESOURCE_PANEL_COLLAPSED_KEY);
  if (rawBackground === null && rawTheme === null && rawEdgeStyle === null && rawCollapsed === null)
    return null;

  return {
    canvasBackground: canvasBackgrounds.includes(rawBackground as CanvasBackground)
      ? (rawBackground as CanvasBackground)
      : workspacePreferenceDefaults.canvasBackground,
    canvasTheme: canvasThemes.includes(rawTheme as CanvasTheme)
      ? (rawTheme as CanvasTheme)
      : workspacePreferenceDefaults.canvasTheme,
    canvasEdgeStyle: canvasEdgeStyles.includes(rawEdgeStyle as CanvasEdgeStyle)
      ? (rawEdgeStyle as CanvasEdgeStyle)
      : workspacePreferenceDefaults.canvasEdgeStyle,
    isResourcePanelCollapsed: rawCollapsed === 'true',
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
      storage.setItem(CANVAS_EDGE_STYLE_KEY, state.canvasEdgeStyle);
      storage.setItem(RESOURCE_PANEL_COLLAPSED_KEY, String(state.isResourcePanelCollapsed));
    } catch {
      // Ignore malformed persistence writes; the in-memory preferences remain usable.
    }
  },
  removeItem: () => {
    const storage = browserStorage();
    storage?.removeItem(CANVAS_BACKGROUND_KEY);
    storage?.removeItem(CANVAS_THEME_KEY);
    storage?.removeItem(CANVAS_EDGE_STYLE_KEY);
    storage?.removeItem(RESOURCE_PANEL_COLLAPSED_KEY);
  },
};

export const useWorkspacePreferences = create<WorkspacePreferencesState>()(
  persist(
    (set) => ({
      ...workspacePreferenceDefaults,
      setCanvasBackground: (canvasBackground) => set({ canvasBackground }),
      setCanvasTheme: (canvasTheme) => set({ canvasTheme }),
      setCanvasEdgeStyle: (canvasEdgeStyle) => set({ canvasEdgeStyle }),
      setResourcePanelCollapsed: (collapsed) =>
        set((state) => ({
          isResourcePanelCollapsed:
            typeof collapsed === 'function' ? collapsed(state.isResourcePanelCollapsed) : collapsed,
        })),
    }),
    {
      name: PERSISTENCE_KEY,
      storage: createJSONStorage(() => preferenceStorage),
      partialize: ({
        canvasBackground,
        canvasTheme,
        canvasEdgeStyle,
        isResourcePanelCollapsed,
      }) => ({
        canvasBackground,
        canvasTheme,
        canvasEdgeStyle,
        isResourcePanelCollapsed,
      }),
    },
  ),
);
