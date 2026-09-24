import { Button } from '@multimodal-canvas/ui';
import { Dropdown, type MenuProps } from 'antd';
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { FolderOpen, LogIn, LogOut, ShieldCheck, UserCircle, Activity } from 'lucide-react';
import type { AuthUser } from '../auth-client';
import { AppLink, appPaths, shouldInterceptAppLink } from '../routing';
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
  /** 当前画布或管理页面的返回项目来源。 */
  projectId?: string | null;
  onNavigate?: (href: string, event: MouseEvent<HTMLAnchorElement>) => void;
};

/** 使用库菜单提供账户入口；链接保留新标签、来源项目和跳转前保存回调。 */
export function AccountMenu({
  user,
  onRequestLogin,
  onLogout,
  onNavigate,
  projectId,
}: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const menuId = useId();

  useEffect(() => {
    setOpen(false);
  }, [user?.id]);

  if (!user) {
    return (
      <Button
        type="button"
        className="mc-navigation-icon-button mc-account-trigger"
        aria-label="登录账户"
        title="登录"
        onClick={onRequestLogin}
      >
        <LogIn size={17} aria-hidden="true" />
      </Button>
    );
  }

  const links = [
    { href: appPaths.resources, label: '我的资源', icon: FolderOpen },
    { href: appPaths.runs, label: '我的任务', icon: Activity },
    ...(user.role === 'admin'
      ? [{ href: appPaths.admin, label: '管理后台', icon: ShieldCheck }]
      : []),
  ];

  return (
    <Dropdown
      open={open}
      onOpenChange={setOpen}
      trigger={['hover', 'click']}
      mouseLeaveDelay={0.14}
      placement="bottomRight"
      autoFocus
      destroyOnHidden
      classNames={{ root: 'mc-account-dropdown' }}
      menu={{
        id: menuId,
        'aria-label': '账户操作',
        items: [
          {
            type: 'group',
            key: 'account',
            label: (
              <div className="mc-account-identity">
                <strong>{user.displayName || '我的账户'}</strong>
                <span>{user.email}</span>
                <small>{user.role === 'admin' ? '管理员' : '普通用户'}</small>
              </div>
            ),
            children: [
              ...links.map(({ href, label, icon: Icon }) => ({
                key: href,
                icon: <Icon size={16} aria-hidden="true" />,
                onClick: ({ domEvent }: Parameters<NonNullable<MenuProps['onClick']>>[0]) => {
                  // 库菜单聚焦 li；键盘激活仍经由原链接执行保存回调和新标签跳转。
                  if (domEvent.type === 'keydown') {
                    domEvent.currentTarget.querySelector<HTMLAnchorElement>('a[href]')?.click();
                  }
                },
                label: (
                  <AppLink
                    to={appPaths.withProject(href, projectId)}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(event) => {
                      const targetHref = appPaths.withProject(href, projectId);
                      // 普通点击交给画布先保存；修饰键继续采用浏览器的新标签行为。
                      if (shouldInterceptAppLink(event, targetHref, undefined, undefined)) {
                        onNavigate?.(targetHref, event);
                      }
                    }}
                  >
                    {label}
                  </AppLink>
                ),
              })),
              { type: 'divider', key: 'logout-divider' },
              {
                key: 'logout',
                label: '退出登录',
                icon: <LogOut size={16} aria-hidden="true" />,
                danger: true,
                onClick: onLogout,
              },
            ],
          },
        ],
      }}
    >
      <Button
        type="button"
        className="mc-navigation-icon-button mc-account-trigger"
        aria-label="账户菜单"
        title={`账户：${user.displayName ?? user.email}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
      >
        <UserCircle size={17} aria-hidden="true" />
      </Button>
    </Dropdown>
  );
}
