/** 后台与个人工作台的路由外壳，以当前身份隔离所有页面查询。 */
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  ArrowLeft,
  Database,
  LayoutDashboard,
  Mail,
  Menu,
  PanelLeftClose,
  Server,
  ShieldCheck,
  UserRound,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { AuthUser, StoredAuthSession } from '../auth-client';
import { AccountMenu, useAccountActions } from '../navigation/AccountMenu';
import { AppLink, navigateApp } from '../routing';
import { BootstrapPage, ProfilePage, SecurityPage, VerifyPage } from './AccountPages';
import { AuditPage, OverviewPage, SystemPage, UserDetailPage, UsersPage } from './AdminPages';
import { ResourceGroupsPage, ResourcesPage, RunsPage } from './ResourcePages';
import { managementRequest, type BootstrapStatus } from './client';
import { QueryState, UserIdentity } from './primitives';
import './management.css';

/** 管理页面与应用统一认证入口的边界。 */
export type ManagementPageProps = {
  /** 当前规范化路径，查询字符串由页面按需读取。 */
  routePath: string;
  /** 应用当前身份；变化时旧身份内容立即卸载。 */
  authUser: AuthUser | null;
  /** 进入统一登录流程，保留用户此前所在项目。 */
  onRequestLogin: () => void;
  /** 新建或更新服务端会话后同步整个应用。 */
  onSessionChanged: (session: StoredAuthSession) => void;
};

/** 导航结构仅描述可访问入口，不能替代服务端授权。 */
type ManagementNav = { path: string; label: string; icon: LucideIcon };

/** 管理员主要入口。 */
const adminNavigation: ManagementNav[] = [
  { path: '/admin', label: '管理概览', icon: LayoutDashboard },
  { path: '/admin/users', label: '用户管理', icon: Users },
  { path: '/admin/resources', label: '用户资源', icon: Database },
  { path: '/admin/runs', label: '全站任务', icon: Activity },
  { path: '/admin/audit', label: '操作记录', icon: ShieldCheck },
  { path: '/admin/settings/email', label: '邮件服务', icon: Mail },
  { path: '/admin/system', label: '系统状态', icon: Server },
];

/** 登录用户的个人入口。 */
const accountNavigation: ManagementNav[] = [
  { path: '/account/profile', label: '个人信息', icon: UserRound },
  { path: '/account/security', label: '账户安全', icon: ShieldCheck },
  { path: '/resources', label: '我的资源', icon: Database },
  { path: '/runs', label: '我的任务', icon: Activity },
];

/**
 * 固定 /admin 首访状态、服务端角色守卫与独立管理工作区。
 * 普通用户和匿名状态不会发起后台业务列表请求。
 */
export function ManagementPage(props: ManagementPageProps) {
  const isAdminPath = props.routePath === '/admin' || props.routePath.startsWith('/admin/');
  const bootstrap = useQuery({
    queryKey: ['management', 'bootstrap'],
    queryFn: ({ signal }) =>
      managementRequest<BootstrapStatus>('/admin/bootstrap', { signal, public: true }),
    enabled: isAdminPath,
    staleTime: 0,
  });
  if (props.routePath === '/auth/verify')
    return (
      <div className="mg-shell is-public">
        <VerifyPage
          onSessionChanged={props.onSessionChanged}
          authUser={props.authUser}
          onRequestLogin={props.onRequestLogin}
        />
      </div>
    );
  if (isAdminPath && (bootstrap.isLoading || bootstrap.error))
    return (
      <div className="mg-shell is-public">
        <QueryState
          loading={bootstrap.isLoading}
          error={bootstrap.error}
          onRetry={() => void bootstrap.refetch()}
        />
        <AppLink to="/" className="mg-back">
          <ArrowLeft size={16} />
          返回主页
        </AppLink>
      </div>
    );
  if (isAdminPath && bootstrap.data && !bootstrap.data.initialized)
    return (
      <div className="mg-shell is-public">
        <BootstrapPage
          status={bootstrap.data}
          onSessionChanged={props.onSessionChanged}
          onInitialized={() => {
            void bootstrap.refetch();
            navigateApp('/admin', { replace: true });
          }}
        />
      </div>
    );
  if (!props.authUser)
    return (
      <div className="mg-shell is-public">
        <div className="mg-access-state">
          <ShieldCheck size={32} />
          <h1>{isAdminPath ? '管理员登录' : '登录你的账户'}</h1>
          <button type="button" className="mg-button is-primary" onClick={props.onRequestLogin}>
            <UserRound size={17} />
            登录
          </button>
          <AppLink to="/" className="mg-back">
            <ArrowLeft size={16} />
            返回主页
          </AppLink>
        </div>
      </div>
    );
  if (isAdminPath && props.authUser.role !== 'admin')
    return (
      <div className="mg-shell is-public">
        <div className="mg-access-state">
          <ShieldCheck size={32} />
          <h1>仅管理员可访问</h1>
          <p>当前账户没有后台管理权限。</p>
          <AppLink to="/account/profile" className="mg-button">
            <UserRound size={16} />
            个人中心
          </AppLink>
          <AppLink to="/workspace" className="mg-back">
            <ArrowLeft size={16} />
            返回工作台
          </AppLink>
        </div>
      </div>
    );
  return <ManagementShell key={props.authUser.id} {...props} user={props.authUser} />;
}

/** 页面切换保留侧栏，旧正文退出期间不可交互，并支持减少动态效果。 */
function ManagementShell({
  routePath,
  user,
  onSessionChanged,
}: ManagementPageProps & { user: AuthUser }) {
  const account = useAccountActions();
  const [displayedPath, setDisplayedPath] = useState(routePath);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [narrow, setNarrow] = useState(
    () => window.matchMedia?.('(max-width: 680px)').matches ?? false,
  );
  const sidebarRef = useRef<HTMLElement>(null);
  const mobileTriggerRef = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const leaving = displayedPath !== routePath;
  useEffect(() => {
    const media = window.matchMedia?.('(max-width: 680px)');
    if (!media) return;
    /** 视口切换同步导航可交互范围，避免隐藏侧栏仍接收 Tab 焦点。 */
    const changed = () => {
      setNarrow(media.matches);
      if (!media.matches) setMobileOpen(false);
    };
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);
  useEffect(() => {
    if (!mobileOpen || !narrow) return;
    const container = sidebarRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    container?.querySelector<HTMLElement>('button, a[href]')?.focus();
    /** 窄屏导航作为临时覆盖层约束焦点，Escape 恢复触发按钮。 */
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        setMobileOpen(false);
        mobileTriggerRef.current?.focus();
      }
      if (event.key !== 'Tab') return;
      const items = Array.from(
        container?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])') ?? [],
      );
      const first = items[0];
      const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', keydown);
    };
  }, [mobileOpen, narrow]);
  useEffect(() => {
    mainRef.current?.focus({ preventScroll: true });
  }, [displayedPath]);
  useEffect(() => {
    if (displayedPath === routePath) return;
    const timer = window.setTimeout(
      () => {
        setDisplayedPath(routePath);
        setMobileOpen(false);
      },
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 140,
    );
    return () => window.clearTimeout(timer);
  }, [displayedPath, routePath]);
  const isAdmin = routePath.startsWith('/admin');
  const navigation = isAdmin ? adminNavigation : accountNavigation;
  return (
    <div
      className={`mg-shell${collapsed ? ' is-collapsed' : ''}${mobileOpen ? ' is-mobile-open' : ''}`}
    >
      <a className="mg-skip" href="#mg-main">
        跳到主要内容
      </a>
      <aside
        ref={sidebarRef}
        className="mg-sidebar"
        aria-label={isAdmin ? '后台导航' : '账户导航'}
        inert={(narrow && !mobileOpen) || undefined}
      >
        <div className="mg-brand">
          <span className="mg-brand-mark">
            <ShieldCheck size={21} />
          </span>
          <span>{isAdmin ? '管理工作台' : '个人工作台'}</span>
          <button
            className="mg-icon mg-mobile-close"
            type="button"
            title="关闭导航"
            aria-label="关闭导航"
            onClick={() => setMobileOpen(false)}
          >
            <X size={17} />
          </button>
        </div>
        <nav>
          {navigation.map(({ path, label, icon: Icon }) => {
            const active =
              path === '/admin'
                ? routePath === path
                : (routePath.startsWith(path) &&
                    !(path === '/admin/users' && routePath.endsWith('/resources'))) ||
                  (path === '/admin/resources' &&
                    /^\/admin\/users\/[^/]+\/resources/.test(routePath));
            return (
              <AppLink
                key={path}
                to={path}
                className={active ? 'is-active' : ''}
                aria-current={active ? 'page' : undefined}
                title={collapsed ? label : undefined}
              >
                <Icon size={19} />
                <span>{label}</span>
              </AppLink>
            );
          })}
        </nav>
        <div className="mg-sidebar-secondary">
          {isAdmin ? (
            <AppLink to="/account/profile">
              <UserRound size={19} />
              <span>个人中心</span>
            </AppLink>
          ) : (
            user.role === 'admin' && (
              <AppLink to="/admin">
                <ShieldCheck size={19} />
                <span>管理后台</span>
              </AppLink>
            )
          )}
          <AppLink to="/workspace">
            <ArrowLeft size={19} />
            <span>返回工作台</span>
          </AppLink>
        </div>
        <div className="mg-sidebar-user">
          <UserIdentity name={user.displayName} email={user.email} avatarUrl={user.avatarUrl} />
        </div>
      </aside>
      <div className="mg-sidebar-shade" onClick={() => setMobileOpen(false)} aria-hidden="true" />
      <div className="mg-workspace" inert={(narrow && mobileOpen) || undefined}>
        <header className="mg-topbar">
          <button
            type="button"
            className="mg-icon mg-desktop-toggle"
            title={collapsed ? '展开侧栏' : '收起侧栏'}
            aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed(!collapsed)}
          >
            <PanelLeftClose size={19} />
          </button>
          <button
            ref={mobileTriggerRef}
            type="button"
            className="mg-icon mg-mobile-toggle"
            title="打开导航"
            aria-label="打开导航"
            aria-expanded={mobileOpen}
            onClick={() => setMobileOpen(!mobileOpen)}
          >
            <Menu size={19} />
          </button>
          <span>{isAdmin ? '后台管理' : '个人中心'}</span>
          <div className="mg-topbar-end">
            {account ? (
              <AccountMenu {...account} />
            ) : (
              <AppLink
                to="/account/profile"
                className="mg-icon"
                title="个人信息"
                aria-label="个人信息"
              >
                <UserRound size={19} />
              </AppLink>
            )}
          </div>
        </header>
        <main
          ref={mainRef}
          tabIndex={-1}
          id="mg-main"
          className={`mg-main${leaving ? ' is-leaving' : ''}`}
          inert={leaving || undefined}
        >
          <div className="mg-page-enter" key={displayedPath}>
            <ManagementContent
              path={displayedPath}
              user={user}
              onSessionChanged={onSessionChanged}
            />
          </div>
        </main>
      </div>
    </div>
  );
}

/** 已经过外层身份检查的页面分发，用户资源必须以明确 userId 为范围。 */
function ManagementContent({ path, user, onSessionChanged }: SessionPropsForContent) {
  if (path === '/admin') return <OverviewPage userId={user.id} />;
  if (path === '/admin/users') return <UsersPage userId={user.id} />;
  if (path === '/admin/resources') return <ResourceGroupsPage userId={user.id} />;
  if (path === '/admin/audit') return <AuditPage userId={user.id} />;
  if (path === '/admin/system' || path === '/admin/settings/email')
    return <SystemPage userId={user.id} emailOnly={path.endsWith('/email')} />;
  if (path === '/admin/runs' || path === '/runs')
    return <RunsPage userId={user.id} admin={path.startsWith('/admin')} />;
  if (path === '/account/security')
    return <SecurityPage userId={user.id} onSessionChanged={onSessionChanged} />;
  if (path === '/account/profile' || path === '/account')
    return <ProfilePage userId={user.id} onSessionChanged={onSessionChanged} />;
  if (path === '/resources') return <ResourcesPage userId={user.id} />;
  const ownerResources = /^\/admin\/users\/([^/]+)\/resources$/.exec(path);
  if (ownerResources)
    return (
      <ResourcesPage
        key={ownerResources[1]}
        userId={user.id}
        ownerId={decodeURIComponent(ownerResources[1]!)}
      />
    );
  const detail = /^\/admin\/users\/([^/]+)$/.exec(path);
  if (detail)
    return (
      <UserDetailPage key={detail[1]} actorId={user.id} userId={decodeURIComponent(detail[1]!)} />
    );
  return (
    <div className="mg-state">
      <h1>页面不存在</h1>
      <AppLink to={user.role === 'admin' ? '/admin' : '/account/profile'} className="mg-button">
        返回工作台
      </AppLink>
    </div>
  );
}

/** 页面分发的已验证身份参数。 */
type SessionPropsForContent = {
  path: string;
  user: AuthUser;
  onSessionChanged: (session: StoredAuthSession) => void;
};
