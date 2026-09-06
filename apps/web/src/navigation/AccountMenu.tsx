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
import { AppLink, appPaths } from '../routing';
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
  const [openedByClick, setOpenedByClick] = useState(false);
  const present = usePresence(open, 140);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const menuId = useId();

  /** 取消悬停离开后的延迟关闭，允许指针经过菜单与按钮之间的间隙。 */
  const cancelHoverClose = () => {
    if (closeTimerRef.current === null) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  };

  /** 延迟关闭悬停菜单，避免指针移动到浮层时因间隙导致菜单闪退。 */
  const scheduleHoverClose = () => {
    cancelHoverClose();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setOpen(false);
      setOpenedByClick(false);
    }, 140);
  };

  /** 关闭菜单并按调用方式恢复焦点，避免干扰链接目标页。 */
  const close = (restoreFocus = false) => {
    cancelHoverClose();
    setOpen(false);
    setOpenedByClick(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (isImeKeyboardEvent(event)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close(true);
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

  useEffect(() => {
    cancelHoverClose();
    setOpen(false);
    setOpenedByClick(false);
  }, [user?.id]);

  useEffect(
    () => () => {
      cancelHoverClose();
    },
    [],
  );

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
      onMouseEnter={() => {
        cancelHoverClose();
        setOpen(true);
      }}
      onMouseLeave={scheduleHoverClose}
      onBlur={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          !event.currentTarget.contains(event.relatedTarget)
        ) {
          close();
        }
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
        onClick={() => {
          cancelHoverClose();
          setOpenedByClick((value) => {
            setOpen(!value);
            return !value;
          });
        }}
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
              target="_blank"
              rel="noopener noreferrer"
              role="menuitem"
              onClick={(event) => {
                onNavigate?.(href, event);
                if (!event.defaultPrevented) close();
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
