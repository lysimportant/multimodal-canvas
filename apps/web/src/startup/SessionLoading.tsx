import { Spin } from 'antd';
import { useEffect, useState } from 'react';

import './SessionLoading.css';

/** 仅切换等待说明的时长，单位毫秒；不影响认证请求的超时预算。 */
const SLOW_SESSION_HINT_MS = 10_000;

/** 会话恢复期间阻挡路由内容；卸载时清理提示计时器，不读写会话或发起请求。 */
export function SessionLoading() {
  const [isSlow, setIsSlow] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setIsSlow(true), SLOW_SESSION_HINT_MS);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <main className="session-loading">
      <div className="session-loading-content" role="status" aria-live="polite" aria-atomic="true">
        <Spin className="session-loading-spinner" size="large" aria-hidden="true" />
        <h1 className="session-loading-title">正在恢复登录状态</h1>
        <p className="session-loading-hint">
          {isSlow
            ? '登录状态恢复耗时较长，仍在等待服务器响应。请检查网络连接，暂时无需刷新。'
            : '正在校验会话，请稍候。'}
        </p>
      </div>
    </main>
  );
}
