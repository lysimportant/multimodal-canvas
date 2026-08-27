import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CANVAS_BACKGROUND_KEY,
  CANVAS_THEME_KEY,
  RESOURCE_PANEL_COLLAPSED_KEY,
  useWorkspacePreferences,
  workspacePreferenceDefaults,
} from './workspace-preferences';

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

  it('persists theme, background, and resource panel state under the existing keys', () => {
    const state = useWorkspacePreferences.getState();
    state.setCanvasTheme('dark');
    state.setCanvasBackground('blank');
    state.setResourcePanelCollapsed(true);

    expect(window.localStorage.getItem(CANVAS_THEME_KEY)).toBe('dark');
    expect(window.localStorage.getItem(CANVAS_BACKGROUND_KEY)).toBe('blank');
    expect(window.localStorage.getItem(RESOURCE_PANEL_COLLAPSED_KEY)).toBe('true');
  });

  it('rehydrates persisted values and rejects unsupported theme values', async () => {
    window.localStorage.setItem(CANVAS_THEME_KEY, 'unsupported');
    window.localStorage.setItem(CANVAS_BACKGROUND_KEY, 'lines');
    window.localStorage.setItem(RESOURCE_PANEL_COLLAPSED_KEY, 'true');

    await useWorkspacePreferences.persist.rehydrate();

    expect(useWorkspacePreferences.getState()).toMatchObject({
      canvasTheme: 'eye-care',
      canvasBackground: 'lines',
      isResourcePanelCollapsed: true,
    });
  });
});
