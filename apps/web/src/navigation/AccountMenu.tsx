import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import {
  FolderOpen,
  LogIn,
  LogOut,
  ShieldCheck,
  UserCircle,
  UserRound,
  LockKeyhole,
  Activity,
} from 'lucide-react';
import type { AuthUser } from '../auth-client';
import { AppLink, appPaths, shouldInterceptAppLink } from '../routing';
import { isImeKeyboardEvent } from '../ime';
import { usePresence } from './motion';
import './account-menu.css';

/** 全站账户入口的状态与显式动作；打开菜单不修改会话。 */
export type AccountActions = {
  user: AuthUser | null;
  onRequestLogin: () => void;
  onLogout: () => void;
};

/** 页面框架共享当前账户，独立组件测试未提供上下文时不显示额外入口。 */
const AccountContext = createContext<AccountActions | null>(null);

/** 将会话动作提供给普通页面导航，不依赖页面层层转发。 */
export function AccountProvider({
  value,
  children,
}: {
  value: AccountActions;
  children: ReactNode;
}) {
  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

/** 返回当前账户动作；没有应用上下文时为 null。 */
export function useAccountActions() {
  return useContext(AccountContext);
}

/** 菜单可独立用于画布；导航回调可先保存当前项目再跳转。 */
export type AccountMenuProps = AccountActions & {
  onNavigate?: (href: string, event: MouseEvent<HTMLAnchorElement>) => void;
};

/** 显示账户菜单、个人页面与独立注销命令，支持键盘、点击外部及退出动画。 */
export function AccountMenu({ user, onRequestLogin, onLogout, onNavigate }: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const present = usePresence(open, 140);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  /** 关闭菜单并按调用方式恢复焦点，避免干扰链接目标页。 */
  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target))
        setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (isImeKeyboardEvent(event)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      const items = Array.from(
        menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
      );
      const index = items.indexOf(document.activeElement as HTMLElement);
      let next: number | undefined;
      if (event.key === 'ArrowDown') next = (index + 1) % items.length;
      if (event.key === 'ArrowUp') next = index <= 0 ? items.length - 1 : index - 1;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = items.length - 1;
      if (next !== undefined && items[next]) {
        event.preventDefault();
        items[next]?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  useEffect(() => setOpen(false), [user?.id]);

  if (!user) {
    return (
      <button
        type="button"
        className="mc-navigation-icon-button mc-account-trigger"
        aria-label="登录账户"
        title="登录"
        onClick={onRequestLogin}
      >
        <LogIn size={17} aria-hidden="true" />
      </button>
    );
  }

  const links = [
    { href: appPaths.profile, label: '个人信息', icon: UserRound },
    { href: appPaths.security, label: '账户安全', icon: LockKeyhole },
    { href: appPaths.resources, label: '我的资源', icon: FolderOpen },
    { href: appPaths.runs, label: '我的任务', icon: Activity },
    ...(user.role === 'admin'
      ? [{ href: appPaths.admin, label: '管理后台', icon: ShieldCheck }]
      : []),
  ];

  return (
    <div
      ref={containerRef}
      className="mc-account"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="mc-navigation-icon-button mc-account-trigger"
        aria-label="账户菜单"
        title={`账户：${user.displayName ?? user.email}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (isImeKeyboardEvent(event)) return;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
            requestAnimationFrame(() => {
              const items = menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
              items?.[event.key === 'ArrowUp' ? items.length - 1 : 0]?.focus();
            });
          }
        }}
      >
        <UserCircle size={17} aria-hidden="true" />
      </button>
      {present && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="账户操作"
          aria-hidden={!open}
          inert={!open}
          className="mc-account-menu"
          data-state={open ? 'open' : 'closed'}
        >
          <div className="mc-account-identity" role="presentation">
            <strong>{user.displayName || '我的账户'}</strong>
            <span>{user.email}</span>
            <small>{user.role === 'admin' ? '管理员' : '普通用户'}</small>
          </div>
          {links.map(({ href, label, icon: Icon }) => (
            <AppLink
              key={href}
              to={href}
              role="menuitem"
              onClick={(event) => {
                onNavigate?.(href, event);
                if (shouldInterceptAppLink(event, href, undefined, undefined)) close();
              }}
            >
              <Icon size={16} aria-hidden="true" />
              {label}
            </AppLink>
          ))}
          <button
            type="button"
            role="menuitem"
            className="mc-account-logout"
            onClick={() => {
              close();
              onLogout();
            }}
          >
            <LogOut size={16} aria-hidden="true" />
            退出登录
          </button>
        </div>
      )}
    </div>
  );
}
