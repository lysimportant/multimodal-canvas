import {
  useCallback,
  useMemo,
  useSyncExternalStore,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from 'react';

import { parseAppRoute, type AppRoute } from './routes';

const APP_NAVIGATION_EVENT = 'multimodal-canvas:navigation';

export type NavigateOptions = {
  replace?: boolean;
  state?: unknown;
};

function currentLocationSnapshot() {
  if (typeof window === 'undefined') return '/';
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function subscribeToLocation(onStoreChange: () => void) {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener('popstate', onStoreChange);
  window.addEventListener(APP_NAVIGATION_EVENT, onStoreChange);
  return () => {
    window.removeEventListener('popstate', onStoreChange);
    window.removeEventListener(APP_NAVIGATION_EVENT, onStoreChange);
  };
}

function resolveSameOriginHref(to: string) {
  if (typeof window === 'undefined') return undefined;
  try {
    const url = new URL(to, window.location.href);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== window.location.origin) {
      return undefined;
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return undefined;
  }
}

export function navigateApp(to: string, options: NavigateOptions = {}) {
  if (typeof window === 'undefined') return false;
  const href = resolveSameOriginHref(to);
  if (!href) return false;
  const method = options.replace ? 'replaceState' : 'pushState';
  window.history[method](options.state ?? null, '', href);
  window.dispatchEvent(new Event(APP_NAVIGATION_EVENT));
  return true;
}

export function useAppRoute(): AppRoute {
  const snapshot = useSyncExternalStore(
    subscribeToLocation,
    currentLocationSnapshot,
    currentLocationSnapshot,
  );
  return useMemo(() => parseAppRoute(snapshot), [snapshot]);
}

export function useAppNavigate() {
  return useCallback((to: string, options?: NavigateOptions) => navigateApp(to, options), []);
}

export function AppRouter({ children }: { children: (route: AppRoute) => ReactNode }) {
  const route = useAppRoute();
  return children(route);
}

export type AppLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
  to: string;
  replace?: boolean;
  state?: unknown;
};

type AppLinkClick = Pick<
  MouseEvent<HTMLAnchorElement>,
  'button' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'
>;

export function shouldInterceptAppLink(
  event: AppLinkClick,
  to: string,
  target: string | undefined,
  download: AppLinkProps['download'],
) {
  return Boolean(
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !download &&
    (target === undefined || target === '_self') &&
    resolveSameOriginHref(to),
  );
}

export function AppLink({ to, replace, state, onClick, target, download, ...props }: AppLinkProps) {
  return (
    <a
      {...props}
      href={to}
      target={target}
      download={download}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || !shouldInterceptAppLink(event, to, target, download)) {
          return;
        }
        event.preventDefault();
        navigateApp(to, { replace, state });
      }}
    />
  );
}
