import {
  Check,
  ExternalLink,
  Home,
  LayoutGrid,
  Mail,
  Menu,
  Palette,
  Settings,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';

import { useWorkspacePreferences, type CanvasTheme } from '../state/workspace-preferences';
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
  id: AppNavigationSection | 'contact';
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
    id: 'contact',
    label: '联系我们',
    description: '获取支持与合作信息',
    href: appPaths.contact,
    icon: Mail,
  },
  {
    id: 'settings',
    label: '设置',
    description: '配置连接与默认模型',
    href: appPaths.settings(),
    icon: Settings,
  },
];

const themeOptions: Array<{ value: CanvasTheme; label: string }> = [
  { value: 'eye-care', label: '护眼' },
  { value: 'light', label: '明亮' },
  { value: 'dark', label: '深色' },
  { value: 'sepia', label: '暖白' },
  { value: 'contrast', label: '高对比' },
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

function ThemeMenu() {
  const theme = useWorkspacePreferences((state) => state.canvasTheme);
  const setTheme = useWorkspacePreferences((state) => state.setCanvasTheme);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();
  const activeIndex = Math.max(
    0,
    themeOptions.findIndex((option) => option.value === theme),
  );
  const activeLabel = themeOptions[activeIndex]?.label ?? '主题';

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || containerRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [open]);

  const focusOption = (index: number) => {
    optionRefs.current[index]?.focus();
  };

  const openWithFocus = (index: number) => {
    setOpen(true);
    window.requestAnimationFrame(() => focusOption(index));
  };

  const closeAndRestoreFocus = () => {
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (isImeKeyboardEvent(event)) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      openWithFocus(activeIndex);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      openWithFocus(themeOptions.length - 1);
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      setOpen(false);
    }
  };

  const handleOptionKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (isImeKeyboardEvent(event)) return;
    let nextIndex: number | null = null;
    if (event.key === 'ArrowDown') nextIndex = (index + 1) % themeOptions.length;
    else if (event.key === 'ArrowUp') {
      nextIndex = (index - 1 + themeOptions.length) % themeOptions.length;
    } else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = themeOptions.length - 1;
    else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeAndRestoreFocus();
      return;
    } else if (event.key === 'Tab') {
      setOpen(false);
      return;
    }

    if (nextIndex !== null) {
      event.preventDefault();
      focusOption(nextIndex);
    }
  };

  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) {
      return;
    }
    setOpen(false);
  };

  return (
    <div
      ref={containerRef}
      className="mc-navigation-theme"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={(event) => {
        if (!event.currentTarget.contains(document.activeElement)) setOpen(false);
      }}
      onBlur={handleBlur}
    >
      <button
        ref={triggerRef}
        type="button"
        className="mc-navigation-icon-button"
        aria-label={`切换主题，当前${activeLabel}`}
        aria-controls={menuId}
        aria-expanded={open}
        aria-haspopup="menu"
        title="切换主题"
        onClick={() => setOpen(true)}
        onKeyDown={handleTriggerKeyDown}
      >
        <Palette size={17} aria-hidden="true" />
      </button>
      {open && (
        <div id={menuId} className="mc-navigation-theme-menu" role="menu" aria-label="界面主题">
          {themeOptions.map((option, index) => (
            <button
              key={option.value}
              ref={(element) => {
                optionRefs.current[index] = element;
              }}
              type="button"
              role="menuitemradio"
              aria-checked={theme === option.value}
              onClick={() => {
                setTheme(option.value);
                closeAndRestoreFocus();
              }}
              onKeyDown={(event) => handleOptionKeyDown(event, index)}
            >
              <span
                className={`mc-navigation-theme-swatch is-${option.value}`}
                aria-hidden="true"
              />
              <span>{option.label}</span>
              {theme === option.value && <Check size={14} aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </div>
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
  const [isScrolled, setIsScrolled] = useState(
    () => typeof window !== 'undefined' && window.scrollY > 16,
  );
  const menuId = useId();
  const titleId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const activeSection = getNavigationSection(route);

  const itemHref = (item: NavigationItem) =>
    item.id === 'settings' ? appPaths.settings(projectId) : item.href;

  useEffect(() => {
    const handleScroll = () => setIsScrolled(window.scrollY > 16);
    handleScroll();
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

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
      <header
        className={['mc-app-navigation', isScrolled ? 'is-scrolled' : '', className]
          .filter(Boolean)
          .join(' ')}
      >
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

        <div className="mc-navigation-actions">
          {actions}
          <AppLink
            className={`mc-navigation-header-link${route.id === 'contact' ? ' is-active' : ''}`}
            to={appPaths.contact}
            aria-current={route.id === 'contact' ? 'page' : undefined}
            onClick={handleNavigation(appPaths.contact)}
          >
            联系我们
          </AppLink>
          <a
            className="mc-navigation-header-link"
            href="https://api.lolicon.beer"
            target="_blank"
            rel="noopener noreferrer"
          >
            API获取
            <ExternalLink size={12} aria-hidden="true" />
          </a>
          <a
            className="mc-navigation-header-link"
            href="https://lolicon.beer"
            target="_blank"
            rel="noopener noreferrer"
          >
            主站
            <ExternalLink size={12} aria-hidden="true" />
          </a>
          <ThemeMenu />
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
                const isActive =
                  item.id === activeSection || (item.id === 'contact' && route.id === 'contact');
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
