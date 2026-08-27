import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';

import type { CanvasBackground } from '../workspace/contracts';

export const CANVAS_BACKGROUND_KEY = 'multimodal-canvas:background';
export const CANVAS_THEME_KEY = 'multimodal-canvas:theme';
export const RESOURCE_PANEL_COLLAPSED_KEY = 'multimodal-canvas:resource-panel-collapsed';

const PERSISTENCE_KEY = 'multimodal-canvas:workspace-preferences';

export type CanvasTheme = 'eye-care' | 'light' | 'dark' | 'sepia' | 'contrast';

type PreferenceValues = {
  canvasBackground: CanvasBackground;
  canvasTheme: CanvasTheme;
  isResourcePanelCollapsed: boolean;
};

type ValueUpdater<T> = T | ((current: T) => T);

export type WorkspacePreferencesState = PreferenceValues & {
  setCanvasBackground: (background: CanvasBackground) => void;
  setCanvasTheme: (theme: CanvasTheme) => void;
  setResourcePanelCollapsed: (collapsed: ValueUpdater<boolean>) => void;
};

export const workspacePreferenceDefaults: PreferenceValues = {
  canvasBackground: 'dots',
  canvasTheme: 'eye-care',
  isResourcePanelCollapsed: false,
};

const canvasBackgrounds: CanvasBackground[] = ['dots', 'lines', 'cross', 'blank'];
const canvasThemes: CanvasTheme[] = ['eye-care', 'light', 'dark', 'sepia', 'contrast'];

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
  const rawCollapsed = storage.getItem(RESOURCE_PANEL_COLLAPSED_KEY);
  if (rawBackground === null && rawTheme === null && rawCollapsed === null) return null;

  return {
    canvasBackground: canvasBackgrounds.includes(rawBackground as CanvasBackground)
      ? (rawBackground as CanvasBackground)
      : workspacePreferenceDefaults.canvasBackground,
    canvasTheme: canvasThemes.includes(rawTheme as CanvasTheme)
      ? (rawTheme as CanvasTheme)
      : workspacePreferenceDefaults.canvasTheme,
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
      storage.setItem(RESOURCE_PANEL_COLLAPSED_KEY, String(state.isResourcePanelCollapsed));
    } catch {
      // Ignore malformed persistence writes; the in-memory preferences remain usable.
    }
  },
  removeItem: () => {
    const storage = browserStorage();
    storage?.removeItem(CANVAS_BACKGROUND_KEY);
    storage?.removeItem(CANVAS_THEME_KEY);
    storage?.removeItem(RESOURCE_PANEL_COLLAPSED_KEY);
  },
};

export const useWorkspacePreferences = create<WorkspacePreferencesState>()(
  persist(
    (set) => ({
      ...workspacePreferenceDefaults,
      setCanvasBackground: (canvasBackground) => set({ canvasBackground }),
      setCanvasTheme: (canvasTheme) => set({ canvasTheme }),
      setResourcePanelCollapsed: (collapsed) =>
        set((state) => ({
          isResourcePanelCollapsed:
            typeof collapsed === 'function' ? collapsed(state.isResourcePanelCollapsed) : collapsed,
        })),
    }),
    {
      name: PERSISTENCE_KEY,
      storage: createJSONStorage(() => preferenceStorage),
      partialize: ({ canvasBackground, canvasTheme, isResourcePanelCollapsed }) => ({
        canvasBackground,
        canvasTheme,
        isResourcePanelCollapsed,
      }),
    },
  ),
);
