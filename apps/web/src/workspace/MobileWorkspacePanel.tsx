import { Drawer } from 'antd';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import './MobileWorkspacePanel.css';

/** 手机画布断点，与浮层样式保持一致；不读取或写入桌面布局偏好。 */
const mobileWorkspaceQuery = '(max-width: 600px)';

/** 订阅手机断点；没有 matchMedia 的渲染环境按桌面处理，卸载时移除监听。 */
export function useMobileWorkspace(): boolean {
  const [mobile, setMobile] = useState(
    () => window.matchMedia?.(mobileWorkspaceQuery).matches ?? false,
  );
  useEffect(() => {
    const query = window.matchMedia?.(mobileWorkspaceQuery);
    if (!query) return;
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return mobile;
}

/** 两处手机浮层共用可访问的抽屉；桌面不插入包装 DOM，保留原布局选择器。 */
interface MobileWorkspacePanelProps {
  /** 当前是否为不超过 600px 的视口。 */
  mobile: boolean;
  /** 手机浮层是否打开，不控制桌面内容。 */
  open: boolean;
  /** 对话框标题，也是辅助技术使用的名称。 */
  title: string;
  /** 与入口 aria-controls 对应的内容标识。 */
  id: string;
  /** 仅区分工具网格与资源列表样式。 */
  kind: 'menu' | 'resources';
  /** 点击遮罩、关闭按钮或 Escape 时通知父级关闭。 */
  onClose: () => void;
  /** 关闭状态提交后恢复入口焦点；切换到其它对话框时省略，避免抢走其输入焦点。 */
  restoreFocusRef?: RefObject<HTMLButtonElement | null>;
  /** 原有控件，沿用原业务回调和禁用状态。 */
  children: ReactNode;
}

/** 手机按需显示原有控件；资源预挂载保留上传引用，菜单关闭后卸载嵌套浮层。 */
export function MobileWorkspacePanel({
  mobile,
  open,
  title,
  id,
  kind,
  onClose,
  restoreFocusRef,
  children,
}: MobileWorkspacePanelProps) {
  const wasOpen = useRef(false);
  useEffect(() => {
    const closing = wasOpen.current && !open;
    wasOpen.current = open;
    if (!mobile || !closing || !restoreFocusRef) return;
    // 关闭状态提交后恢复焦点，不依赖可能被系统减弱动画跳过的动画回调。
    const frame = requestAnimationFrame(() => {
      restoreFocusRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [mobile, open, restoreFocusRef]);
  if (!mobile) return children;
  return (
    <Drawer
      open={open}
      onClose={onClose}
      focusable={{ focusTriggerAfterClose: false }}
      title={title}
      placement="right"
      size="min(360px, calc(100vw - 24px))"
      zIndex={70}
      forceRender={kind === 'resources'}
      destroyOnHidden={kind === 'menu'}
      closable={{ placement: 'end', 'aria-label': `关闭${title}` }}
      rootClassName={`mobile-workspace-panel mobile-workspace-${kind}`}
      styles={{ body: { padding: kind === 'resources' ? 0 : 16 } }}
    >
      <div id={id} className="mobile-workspace-panel-content">
        {children}
      </div>
    </Drawer>
  );
}
