import { Button } from '@multimodal-canvas/ui';
import { Drawer, Dropdown } from 'antd';
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
import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from 'react';

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

import { PUBLIC_API_CATALOG_URL } from '../workspace/contracts';
import './app-navigation.css';

import { AccountMenu, useAccountActions } from './AccountMenu';

/** 主菜单路由及用于当前页面高亮的元数据。 */
type NavigationItem = {
  id: AppNavigationSection | 'contact';
  label: string;
  description: string;
  href: string;
  icon: LucideIcon;
};

/** 保留公共入口顺序，管理员设置入口在渲染时按账户权限过滤。 */
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
    description: '查看分组模型与画布偏好',
    href: appPaths.settings(),
    icon: Settings,
  },
];

/** 已持久化的主题标识，迁移控件时不改变偏好存储格式。 */
const themeOptions: Array<{ value: CanvasTheme; label: string }> = [
  { value: 'eye-care', label: '护眼' },
  { value: 'light', label: '明亮' },
  { value: 'dark', label: '深色' },
  { value: 'sepia', label: '暖白' },
  { value: 'contrast', label: '高对比' },
];

/** 导航上下文；onNavigate 可阻止默认跳转并先保存当前项目。 */
export type AppNavigationProps = {
  route: AppRoute;
  projectId?: string | null;
  actions?: ReactNode;
  className?: string;
  onNavigate?: (href: string, event: MouseEvent<HTMLAnchorElement>) => void;
};

/** 主题选项由库菜单处理悬停、键盘导航和外部点击。 */
function ThemeMenu() {
  const theme = useWorkspacePreferences((state) => state.canvasTheme);
  const setTheme = useWorkspacePreferences((state) => state.setCanvasTheme);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const activeLabel = themeOptions.find((option) => option.value === theme)?.label ?? '主题';

  return (
    <Dropdown
      open={open}
      onOpenChange={setOpen}
      trigger={['hover', 'click']}
      placement="bottomRight"
      autoFocus
      destroyOnHidden
      classNames={{ root: 'mc-navigation-theme-menu' }}
      menu={{
        id: menuId,
        'aria-label': '界面主题',
        selectable: true,
        selectedKeys: [theme],
        items: themeOptions.map((option) => ({
          key: option.value,
          role: 'menuitemradio',
          'aria-checked': theme === option.value,
          label: (
            <span className="mc-navigation-theme-option">
              <span
                className={`mc-navigation-theme-swatch is-${option.value}`}
                aria-hidden="true"
              />
              <span>{option.label}</span>
              {theme === option.value && <Check size={14} aria-hidden="true" />}
            </span>
          ),
          onClick: () => {
            setTheme(option.value);
            triggerRef.current?.focus();
          },
        })),
      }}
    >
      <Button
        ref={triggerRef}
        type="button"
        className="mc-navigation-icon-button"
        aria-label={`切换主题，当前${activeLabel}`}
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        title="切换主题"
      >
        <Palette size={17} aria-hidden="true" />
      </Button>
    </Dropdown>
  );
}

/** 渲染公共导航与主菜单；跳转前保留调用方的保存和路由拦截逻辑。 */
export function AppNavigation({
  route,
  projectId,
  actions,
  className = '',
  onNavigate,
}: AppNavigationProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const account = useAccountActions();
  const [isScrolled, setIsScrolled] = useState(
    () => typeof window !== 'undefined' && window.scrollY > 16,
  );
  const menuId = useId();
  const drawerRef = useRef<HTMLDivElement>(null);
  const activeSection = getNavigationSection(route);

  /** 普通导航与账户入口使用同一返回来源，目标页面查询参数保持独立。 */
  const returnProjectId = projectId ?? route.returnProjectId;
  const itemHref = (item: NavigationItem) =>
    appPaths.withProject(
      item.id === 'settings' ? appPaths.settings(returnProjectId) : item.href,
      returnProjectId,
    );

  useEffect(() => {
    const handleScroll = () => setIsScrolled(window.scrollY > 16);
    handleScroll();
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

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
          <Button
            type="button"
            className="mc-navigation-icon-button mc-navigation-menu-trigger"
            aria-label="打开主菜单"
            aria-expanded={menuOpen}
            aria-controls={menuId}
            aria-haspopup="dialog"
            onClick={() => setMenuOpen(true)}
          >
            <Menu size={18} aria-hidden="true" />
          </Button>
          <AppLink
            className="mc-navigation-brand"
            to={appPaths.withProject(appPaths.home, returnProjectId)}
            aria-label="Multimodal Canvas 主页"
            onClick={handleNavigation(appPaths.withProject(appPaths.home, returnProjectId))}
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
            to={appPaths.withProject(appPaths.contact, returnProjectId)}
            aria-current={route.id === 'contact' ? 'page' : undefined}
            onClick={handleNavigation(appPaths.withProject(appPaths.contact, returnProjectId))}
          >
            联系我们
          </AppLink>
          <a
            className="mc-navigation-header-link"
            href={PUBLIC_API_CATALOG_URL}
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
          {account && !className.includes('mc-canvas-navigation') && (
            <AccountMenu {...account} projectId={returnProjectId} onNavigate={onNavigate} />
          )}
        </div>
      </header>

      <Drawer
        open={menuOpen}
        id={menuId}
        panelRef={drawerRef}
        placement="left"
        size="min(88vw, 390px)"
        destroyOnHidden
        classNames={{
          root: 'mc-navigation-overlay',
          section: 'mc-navigation-drawer',
          header: 'mc-navigation-drawer-header',
          body: 'mc-navigation-drawer-body',
          footer: 'mc-navigation-drawer-footer',
        }}
        title={
          <div>
            <span className="mc-navigation-drawer-kicker" aria-hidden="true">
              NAVIGATION
            </span>
            <h2>Multimodal Canvas</h2>
          </div>
        }
        closable={{ placement: 'end', 'aria-label': '关闭主菜单' }}
        closeIcon={<X size={18} aria-hidden="true" />}
        onClose={(event) => {
          if ('key' in event && isImeKeyboardEvent(event)) return;
          setMenuOpen(false);
        }}
        afterOpenChange={(visible) => {
          if (visible)
            drawerRef.current?.querySelector<HTMLElement>('[aria-current="page"]')?.focus();
        }}
        footer={
          <>
            <span>文字 · 图片 · 音频 · 视频</span>
            <span>统一工作流</span>
          </>
        }
      >
        <nav className="mc-navigation-drawer-links" aria-label="菜单导航">
          {navigationItems
            .filter(
              (item) => item.id !== 'settings' || !account?.user || account.user.role === 'admin',
            )
            .map((item, index) => {
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
      </Drawer>
    </>
  );
}
