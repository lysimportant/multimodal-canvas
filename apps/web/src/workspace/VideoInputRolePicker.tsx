import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { Connection } from '@xyflow/react';
import { videoImageRolesForMode, type PortRole, type VideoMode } from '@multimodal-canvas/domain';

import { videoInputRoleLabel } from '../NodeHandles';

const VIEWPORT_PADDING = 8;

const roleHints: Partial<Record<PortRole, string>> = {
  firstFrame: '作为视频起始画面',
  lastFrame: '作为视频结束画面',
  referenceImage: '作为融合参考，不固定首尾帧',
};

export type VideoInputRolePickerTarget = {
  connection: Connection;
  clientPosition: { x: number; y: number };
};

type VideoInputRolePickerProps = {
  target: VideoInputRolePickerTarget;
  onSelect: (role: PortRole) => void;
  onClose: () => void;
  videoMode?: VideoMode;
};

function getEnabledItems(menu: HTMLDivElement | null) {
  return menu ? Array.from(menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')) : [];
}

/**
 * 图片落到视频节点主体时的角色选择菜单。
 * 取消或点击外部不创建连线。
 */
export function VideoInputRolePicker({
  target,
  onSelect,
  onClose,
  videoMode,
}: VideoInputRolePickerProps) {
  const roles = videoImageRolesForMode(videoMode);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(target.clientPosition);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const bounds = menu.getBoundingClientRect();
    const maxLeft = Math.max(VIEWPORT_PADDING, window.innerWidth - bounds.width - VIEWPORT_PADDING);
    const maxTop = Math.max(
      VIEWPORT_PADDING,
      window.innerHeight - bounds.height - VIEWPORT_PADDING,
    );
    setPosition({
      x: Math.max(VIEWPORT_PADDING, Math.min(target.clientPosition.x, maxLeft)),
      y: Math.max(VIEWPORT_PADDING, Math.min(target.clientPosition.y, maxTop)),
    });
  }, [target]);

  useLayoutEffect(() => {
    getEnabledItems(menuRef.current)[0]?.focus({ preventScroll: true });
  }, [target]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const handleWindowBlur = () => onClose();
    document.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('blur', handleWindowBlur);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, [onClose]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    const items = getEnabledItems(menuRef.current);
    if (items.length === 0) return;
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    let nextIndex: number | undefined;
    if (event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % items.length;
    if (event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + items.length) % items.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = items.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    items[nextIndex]?.focus({ preventScroll: true });
  };

  return createPortal(
    <div
      ref={menuRef}
      className="canvas-context-menu"
      role="menu"
      aria-label={'选择图片在视频中的用途'}
      style={{ left: position.x, top: position.y }}
      onKeyDown={handleKeyDown}
    >
      <div className="canvas-context-menu-heading">{'这张图在视频里做什么？'}</div>
      <p className="canvas-context-menu-label">
        {videoMode === 'first_last_frame'
          ? '首尾帧模式只区分起始画面和结束画面。'
          : '未取证的角色仍可连线保存；真实运行前不支持会明确失败。'}
      </p>
      <div className="canvas-context-menu-group">
        {roles.map((role) => (
          <button
            key={role}
            type="button"
            role="menuitem"
            className="canvas-context-menu-item"
            onClick={() => onSelect(role)}
          >
            <span>
              {videoInputRoleLabel(role, videoMode)}
              <small style={{ display: 'block', fontSize: 10, opacity: 0.72 }}>
                {roleHints[role]}
              </small>
            </span>
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}
