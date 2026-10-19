import { App, Button, Flex } from 'antd';
import { X } from 'lucide-react';
import {
  createElement,
  useCallback,
  useEffect,
  useId,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { getNoticeAutoDismissMs, type Notice } from './app-contract-utils';

/**
 * 操作提示沿用 setState 调用契约，由应用级 Ant Design message 负责浮层。
 * 每个调用方只更新、清理自己的消息，重复内容也会重新开始显示时间。
 */
export function useAppNotice(): Dispatch<SetStateAction<Notice | null>> {
  const { message } = App.useApp();
  const key = useId();
  const [request, setRequest] = useState<{ notice: Notice | null }>({ notice: null });
  const setNotice = useCallback<Dispatch<SetStateAction<Notice | null>>>((value) => {
    setRequest((current) => ({
      notice: typeof value === 'function' ? value(current.notice) : value,
    }));
  }, []);

  useEffect(() => {
    const { notice } = request;
    if (!notice) {
      message.destroy(key);
      return;
    }
    const close = () => {
      setRequest((current) => (current === request ? { notice: null } : current));
    };
    void message.open({
      key,
      type: notice.kind,
      // 同 key 更新时组件库会沿用旧计时；由当前请求管理关闭，避免过期提示关闭新消息。
      duration: 0,
      content: createElement(
        Flex,
        { align: 'center', gap: 8 },
        createElement('span', null, notice.message),
        createElement(Button, {
          type: 'text',
          size: 'small',
          shape: 'circle',
          'aria-label': '关闭提示',
          icon: createElement(X, { size: 14, 'aria-hidden': true }),
          onClick: close,
        }),
      ),
      onClose: close,
    });
    const duration = getNoticeAutoDismissMs(notice);
    if (duration === null) return;
    const timer = window.setTimeout(close, duration);
    return () => window.clearTimeout(timer);
  }, [key, message, request]);

  useEffect(() => () => message.destroy(key), [key, message]);

  return setNotice;
}
