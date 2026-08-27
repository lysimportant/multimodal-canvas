import { Home, LayoutGrid, Menu, Moon, Settings, Sun, X, type LucideIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from 'react';

import { useWorkspacePreferences } from '../state/workspace-preferences';
import { isImeKeyboardEvent } from '../ime';
import {
  AppLink,
  appPaths,
  getNavigationSection,
  shouldInterceptAppLink,
  type AppNavigationSection,
  type AppRoute,
} from '../routing';

import './app-navigation.css';

type NavigationItem = {
  id: AppNavigationSection;
  label: string;
  description: string;
  href: string;
  icon: LucideIcon;
};

const navigationItems: NavigationItem[] = [
  {
    id: 'home',
    label: '主页',
    description: '了解产品与生成能力',
    href: appPaths.home,
    icon: Home,
  },
  {
    id: 'workspace',
    label: '工作台',
    description: '管理项目并进入画布',
    href: appPaths.workspace,
    icon: LayoutGrid,
  },
  {
    id: 'settings',
    label: '设置',
    description: '配置连接与默认模型',
    href: appPaths.settings(),
    icon: Settings,
  },
];

export type AppNavigationProps = {
  route: AppRoute;
  projectId?: string | null;
  actions?: ReactNode;
  className?: string;
  onNavigate?: (href: string, event: MouseEvent<HTMLAnchorElement>) => void;
};

function focusableElements(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

function ThemeToggle() {
  const theme = useWorkspacePreferences((state) => state.canvasTheme);
  const setTheme = useWorkspacePreferences((state) => state.setCanvasTheme);
  const isDark = theme === 'dark';
  const nextTheme = isDark ? 'light' : 'dark';
  const label = isDark ? '切换到浅色主题' : '切换到深色主题';

  return (
    <button
      type="button"
      className="mc-navigation-icon-button"
      aria-label={label}
      title={label}
      onClick={() => setTheme(nextTheme)}
    >
      {isDark ? <Sun size={17} aria-hidden="true" /> : <Moon size={17} aria-hidden="true" />}
    </button>
  );
}

export function AppNavigation({
  route,
  projectId,
  actions,
  className = '',
  onNavigate,
}: AppNavigationProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = useId();
  const titleId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const activeSection = getNavigationSection(route);

  const itemHref = (item: NavigationItem) =>
    item.id === 'settings' ? appPaths.settings(projectId) : item.href;

  useEffect(() => {
    if (!menuOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const frame = window.requestAnimationFrame(() => {
      const activeLink = drawerRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
      const firstTarget = activeLink ?? focusableElements(drawerRef.current!)[0];
      firstTarget?.focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isImeKeyboardEvent(event)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        setMenuOpen(false);
        window.requestAnimationFrame(() => triggerRef.current?.focus());
        return;
      }
      if (event.key !== 'Tab' || !drawerRef.current) return;
      const focusable = focusableElements(drawerRef.current);
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuOpen]);

  const handleNavigation = (href: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    onNavigate?.(href, event);
    if (
      !event.defaultPrevented &&
      shouldInterceptAppLink(
        event,
        href,
        event.currentTarget.target || undefined,
        event.currentTarget.download || undefined,
      )
    ) {
      setMenuOpen(false);
    }
  };

  return (
    <>
      <header className={`mc-app-navigation ${className}`.trim()}>
        <div className="mc-navigation-leading">
          <button
            ref={triggerRef}
            type="button"
            className="mc-navigation-icon-button mc-navigation-menu-trigger"
            aria-label="打开主菜单"
            aria-expanded={menuOpen}
            aria-controls={menuId}
            aria-haspopup="dialog"
            onClick={() => setMenuOpen(true)}
          >
            <Menu size={18} aria-hidden="true" />
          </button>
          <AppLink
            className="mc-navigation-brand"
            to={appPaths.home}
            aria-label="Multimodal Canvas 主页"
            onClick={handleNavigation(appPaths.home)}
          >
            <span className="mc-navigation-brand-mark" aria-hidden="true">
              MC
            </span>
            <span className="mc-navigation-brand-copy">
              <strong>Multimodal Canvas</strong>
              <small>生成工作流</small>
            </span>
          </AppLink>
        </div>

        <nav className="mc-navigation-primary" aria-label="主导航">
          {navigationItems.map((item) => {
            const href = itemHref(item);
            const isActive = item.id === activeSection;
            return (
              <AppLink
                key={item.id}
                className={`mc-navigation-primary-link${isActive ? ' is-active' : ''}`}
                to={href}
                aria-current={isActive ? 'page' : undefined}
                onClick={handleNavigation(href)}
              >
                {item.label}
              </AppLink>
            );
          })}
        </nav>

        <div className="mc-navigation-actions">
          {actions}
          <ThemeToggle />
        </div>
      </header>

      {menuOpen && (
        <div
          className="mc-navigation-overlay"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target !== event.currentTarget) return;
            setMenuOpen(false);
            window.requestAnimationFrame(() => triggerRef.current?.focus());
          }}
        >
          <aside
            ref={drawerRef}
            className="mc-navigation-drawer"
            id={menuId}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
          >
            <div className="mc-navigation-drawer-header">
              <div>
                <span className="mc-navigation-drawer-kicker">NAVIGATION</span>
                <h2 id={titleId}>Multimodal Canvas</h2>
              </div>
              <button
                type="button"
                className="mc-navigation-icon-button"
                aria-label="关闭主菜单"
                title="关闭"
                onClick={() => {
                  setMenuOpen(false);
                  window.requestAnimationFrame(() => triggerRef.current?.focus());
                }}
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>

            <nav className="mc-navigation-drawer-links" aria-label="菜单导航">
              {navigationItems.map((item, index) => {
                const Icon = item.icon;
                const href = itemHref(item);
                const isActive = item.id === activeSection;
                return (
                  <AppLink
                    key={item.id}
                    className={`mc-navigation-drawer-link${isActive ? ' is-active' : ''}`}
                    to={href}
                    aria-current={isActive ? 'page' : undefined}
                    onClick={handleNavigation(href)}
                  >
                    <span className="mc-navigation-drawer-index" aria-hidden="true">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <Icon size={18} aria-hidden="true" />
                    <span>
                      <strong>{item.label}</strong>
                      <small>{item.description}</small>
                    </span>
                  </AppLink>
                );
              })}
            </nav>

            <div className="mc-navigation-drawer-footer">
              <span>文字 · 图片 · 音频 · 视频</span>
              <span>统一工作流</span>
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
