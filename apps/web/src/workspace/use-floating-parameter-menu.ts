import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';

/** 浮动菜单定位所需的元素与状态；原生 Popover 顶层使菜单不被参数页滚动区域裁切。 */
type FloatingParameterMenuOptions = {
  /** 触发器所在的控件根元素。 */
  anchorRef: RefObject<HTMLElement | null>;
  /** 具有 popover="manual" 的菜单元素。 */
  menuRef: RefObject<HTMLElement | null>;
  /** 是否启用脱离滚动裁剪的菜单定位。 */
  enabled: boolean;
  /** 菜单当前是否展开。 */
  open: boolean;
  /** 首选展开方向；空间不足时压缩菜单并允许内部滚动。 */
  placement: 'top' | 'bottom';
};

/**
 * 根据视口定位参数菜单，优先向指定方向展示，空间不足时翻转。
 * 仅改变浮层样式和展示层级，不修改参数；关闭后移除滚动/缩放监听。
 */
export function useFloatingParameterMenu({
  anchorRef,
  menuRef,
  enabled,
  open,
  placement,
}: FloatingParameterMenuOptions): CSSProperties | undefined {
  /** 视口像素坐标；仅在启用浮动菜单时覆盖原有菜单样式。 */
  const [style, setStyle] = useState<CSSProperties>();

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!enabled || !menu) return;
    if (!open) {
      if (menu.hidePopover && menu.matches(':popover-open')) menu.hidePopover();
      return;
    }

    /** 保留 8 像素视口边距和 6 像素触发器间隔，并随滚动更新定位。 */
    const updatePosition = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const bounds = anchor.getBoundingClientRect();
      const width = Math.min(300, window.innerWidth - 16);
      const above = Math.max(0, bounds.top - 14);
      const below = Math.max(0, window.innerHeight - bounds.bottom - 14);
      const showAbove =
        placement === 'top' ? above >= 100 || above >= below : below < 100 && above > below;
      setStyle({
        position: 'fixed',
        inset: 'auto',
        margin: 0,
        left: Math.max(8, Math.min(bounds.left, window.innerWidth - width - 8)),
        width,
        minWidth: 0,
        maxHeight: Math.min(320, showAbove ? above : below),
        ...(showAbove
          ? { bottom: window.innerHeight - bounds.top + 6 }
          : { top: bounds.bottom + 6 }),
        transform: 'none',
      });
    };
    updatePosition();
    menu.showPopover?.();
    window.addEventListener('resize', updatePosition);
    document.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      document.removeEventListener('scroll', updatePosition, true);
      if (menu.hidePopover && menu.matches(':popover-open')) menu.hidePopover();
    };
  }, [anchorRef, enabled, menuRef, open, placement]);

  return enabled ? style : undefined;
}
