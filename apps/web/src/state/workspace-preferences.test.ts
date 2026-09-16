import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CANVAS_BACKGROUND_KEY,
  CANVAS_EDGE_STYLE_KEY,
  CANVAS_THEME_KEY,
  IMAGE_EDIT_SOURCE_CARD_KEY,
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

  it('persists theme, background, edge style, and resource panel state under stable keys', () => {
    const state = useWorkspacePreferences.getState();
    state.setCanvasTheme('dark');
    state.setCanvasBackground('blank');
    state.setCanvasEdgeStyle('pulse');
    state.setResourcePanelCollapsed(true);
    state.setShowImageEditSourceCard(false);

    expect(window.localStorage.getItem(CANVAS_THEME_KEY)).toBe('dark');
    expect(window.localStorage.getItem(CANVAS_BACKGROUND_KEY)).toBe('blank');
    expect(window.localStorage.getItem(CANVAS_EDGE_STYLE_KEY)).toBe('pulse');
    expect(window.localStorage.getItem(RESOURCE_PANEL_COLLAPSED_KEY)).toBe('true');
    expect(window.localStorage.getItem(IMAGE_EDIT_SOURCE_CARD_KEY)).toBe('false');
  });

  it('rehydrates persisted values and rejects unsupported appearance values', async () => {
    window.localStorage.setItem(CANVAS_THEME_KEY, 'unsupported');
    window.localStorage.setItem(CANVAS_BACKGROUND_KEY, 'lines');
    window.localStorage.setItem(RESOURCE_PANEL_COLLAPSED_KEY, 'true');
    window.localStorage.setItem(CANVAS_EDGE_STYLE_KEY, 'unsupported');

    await useWorkspacePreferences.persist.rehydrate();

    expect(useWorkspacePreferences.getState()).toMatchObject({
      canvasTheme: 'eye-care',
      canvasBackground: 'lines',
      canvasEdgeStyle: 'flow',
      isResourcePanelCollapsed: true,
      showImageEditSourceCard: true,
    });
  });
});
