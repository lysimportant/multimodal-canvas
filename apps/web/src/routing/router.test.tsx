import '@testing-library/jest-dom/vitest';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppLink, AppRouter, navigateApp, shouldInterceptAppLink } from './router';
import { appPaths, getNavigationSection, parseAppRoute } from './routes';

describe('application route contracts', () => {
  it('parses every supported route and settings project context', () => {
    expect(parseAppRoute('/')).toEqual({ id: 'home', pathname: '/' });
    expect(parseAppRoute('/workspace/')).toEqual({ id: 'workspace', pathname: '/workspace' });
    expect(parseAppRoute('/settings?project=project%201')).toEqual({
      id: 'settings',
      pathname: '/settings',
      projectId: 'project 1',
    });
    expect(parseAppRoute('/projects/project%201')).toEqual({
      id: 'project',
      pathname: '/projects/project%201',
      projectId: 'project 1',
    });
    expect(parseAppRoute('/missing')).toEqual({ id: 'not-found', pathname: '/missing' });
    expect(parseAppRoute('/projects/%2F')).toEqual({
      id: 'not-found',
      pathname: '/projects/%2F',
    });
  });

  it('builds encoded paths and highlights project canvases as workspace content', () => {
    expect(appPaths.project('project / 1')).toBe('/projects/project%20%2F%201');
    expect(appPaths.settings('project 1')).toBe('/settings?project=project+1');
    expect(getNavigationSection(parseAppRoute('/projects/project-1'))).toBe('workspace');
    expect(getNavigationSection(parseAppRoute('/not-found'))).toBeNull();
  });
});

describe('History API router', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
  });

  afterEach(() => cleanup());

  it('updates after application navigation and browser back/forward', async () => {
    render(
      <AppRouter>
        {(route) => <output aria-label="current-route">{`${route.id}:${route.pathname}`}</output>}
      </AppRouter>,
    );

    expect(screen.getByLabelText('current-route')).toHaveTextContent('home:/');
    act(() => expect(navigateApp('/workspace')).toBe(true));
    expect(screen.getByLabelText('current-route')).toHaveTextContent('workspace:/workspace');
    act(() => expect(navigateApp('/settings')).toBe(true));
    expect(screen.getByLabelText('current-route')).toHaveTextContent('settings:/settings');

    window.history.back();
    await waitFor(() =>
      expect(screen.getByLabelText('current-route')).toHaveTextContent('workspace:/workspace'),
    );
    window.history.forward();
    await waitFor(() =>
      expect(screen.getByLabelText('current-route')).toHaveTextContent('settings:/settings'),
    );
  });

  it('intercepts an unmodified same-origin primary-button link', () => {
    render(<AppLink to="/workspace">普通链接</AppLink>);
    fireEvent.click(screen.getByRole('link', { name: '普通链接' }));
    expect(window.location.pathname).toBe('/workspace');
  });

  it('preserves modifier, middle-button, target, download, and external navigation', () => {
    const primaryClick = {
      button: 0,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
    };
    expect(shouldInterceptAppLink(primaryClick, '/workspace', undefined, undefined)).toBe(true);
    expect(
      shouldInterceptAppLink(
        { ...primaryClick, ctrlKey: true },
        '/workspace',
        undefined,
        undefined,
      ),
    ).toBe(false);
    expect(
      shouldInterceptAppLink(
        { ...primaryClick, metaKey: true },
        '/workspace',
        undefined,
        undefined,
      ),
    ).toBe(false);
    expect(
      shouldInterceptAppLink(
        { ...primaryClick, shiftKey: true },
        '/workspace',
        undefined,
        undefined,
      ),
    ).toBe(false);
    expect(
      shouldInterceptAppLink({ ...primaryClick, button: 1 }, '/workspace', undefined, undefined),
    ).toBe(false);
    expect(shouldInterceptAppLink(primaryClick, '/workspace', '_blank', undefined)).toBe(false);
    expect(shouldInterceptAppLink(primaryClick, '/workspace', undefined, 'canvas.json')).toBe(
      false,
    );
    expect(
      shouldInterceptAppLink(primaryClick, 'https://example.com/docs', undefined, undefined),
    ).toBe(false);
  });
});
