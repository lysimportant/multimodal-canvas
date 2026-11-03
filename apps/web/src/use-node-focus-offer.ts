import { App, Button, Flex } from 'antd';
import { createElement, useCallback, useEffect, useId, useRef } from 'react';

/** 提示停留时间：8 秒内没有操作就自动消失。 */
export const NODE_FOCUS_OFFER_DURATION_SECONDS = 8;

/**
 * 节点生成完成后的聚焦邀请：默认只提示，用户点「聚焦」才移动视口。
 * 同一节点的完成提示复用同一条 message，重复出现时重新计时。
 */
export function useNodeFocusOffer(
  onFocus: (nodeId: string) => void,
): (nodeId: string, label: string) => void {
  const { message } = App.useApp();
  const instanceId = useId();
  const onFocusRef = useRef(onFocus);
  onFocusRef.current = onFocus;
  const openedKeysRef = useRef(new Set<string>());

  useEffect(
    () => () => {
      for (const key of openedKeysRef.current) message.destroy(key);
      openedKeysRef.current.clear();
    },
    [message],
  );

  return useCallback(
    (nodeId: string, label: string) => {
      const key = `${instanceId}node-focus-${nodeId}`;
      openedKeysRef.current.add(key);
      const dismiss = () => {
        openedKeysRef.current.delete(key);
        message.destroy(key);
      };
      void message.open({
        key,
        type: 'success',
        duration: NODE_FOCUS_OFFER_DURATION_SECONDS,
        content: createElement(
          Flex,
          { align: 'center', gap: 8 },
          createElement('span', null, `「${label}」已生成完成，是否聚焦到该节点？`),
          createElement(
            Button,
            {
              type: 'primary',
              size: 'small',
              onClick: () => {
                dismiss();
                onFocusRef.current(nodeId);
              },
            },
            '聚焦',
          ),
          createElement(Button, { type: 'text', size: 'small', onClick: dismiss }, '忽略'),
        ),
      });
    },
    [instanceId, message],
  );
}
