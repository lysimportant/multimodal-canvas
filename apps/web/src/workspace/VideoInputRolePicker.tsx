import { Dropdown } from 'antd';
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { Connection } from '@xyflow/react';
import { videoImageRolesForMode, type PortRole, type VideoMode } from '@multimodal-canvas/domain';

import { videoInputRoleLabel } from '../NodeHandles';
import './canvas-context-menu.css';

/** 图片输入角色的业务用途，随菜单项展示。 */
const roleHints: Partial<Record<PortRole, string>> = {
  firstFrame: '作为视频起始画面',
  lastFrame: '作为视频结束画面',
  referenceImage: '作为融合参考，不固定首尾帧',
};

/** 待连接图片与菜单的屏幕坐标；选择前不会保存连线。 */
export type VideoInputRolePickerTarget = {
  connection: Connection;
  clientPosition: { x: number; y: number };
};

/** 选择只提交输入角色，取消只关闭菜单，均由调用方决定持久化。 */
type VideoInputRolePickerProps = {
  target: VideoInputRolePickerTarget;
  onSelect: (role: PortRole) => void;
  onClose: () => void;
  videoMode?: VideoMode;
};

/** 图片落到视频节点后的角色菜单；定位、键盘导航与焦点由 Dropdown 管理。 */
export function VideoInputRolePicker({
  target,
  onSelect,
  onClose,
  videoMode,
}: VideoInputRolePickerProps) {
  const roles = videoImageRolesForMode(videoMode);
  useEffect(() => {
    window.addEventListener('blur', onClose);
    return () => window.removeEventListener('blur', onClose);
  }, [onClose]);

  return createPortal(
    <Dropdown
      open
      autoFocus
      trigger={['click']}
      placement="bottomLeft"
      align={{ offset: [0, 0] }}
      destroyOnHidden
      onOpenChange={(next, info) => {
        if (!next && info.source === 'trigger') onClose();
      }}
      classNames={{ root: 'canvas-context-dropdown' }}
      menu={{
        'aria-label': '选择图片在视频中的用途',
        selectable: false,
        onPointerDown: (event) => event.stopPropagation(),
        items: [
          {
            type: 'group',
            key: 'roles',
            label: (
              <>
                <div className="canvas-context-menu-heading">这张图在视频里做什么？</div>
                <p className="canvas-context-menu-label">
                  {videoMode === 'first_last_frame'
                    ? '首尾帧模式只区分起始画面和结束画面。'
                    : '未取证的角色仍可连线保存；真实运行前不支持会明确失败。'}
                </p>
              </>
            ),
            children: roles.map((role) => ({
              key: role,
              label: (
                <span className="canvas-context-menu-item-copy">
                  <span>{videoInputRoleLabel(role, videoMode)}</span>
                  <small className="canvas-context-menu-item-desc">{roleHints[role]}</small>
                </span>
              ),
              onClick: () => onSelect(role),
            })),
          },
        ],
      }}
    >
      <span
        aria-hidden="true"
        style={{
          position: 'fixed',
          left: target.clientPosition.x,
          top: target.clientPosition.y,
          width: 1,
          height: 1,
          pointerEvents: 'none',
        }}
      />
    </Dropdown>,
    document.body,
  );
}
