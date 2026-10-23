import { createContext, useEffect, useState } from 'react';
import type { Asset } from '@multimodal-canvas/domain';
import { z } from 'zod';
import { serverClockNow } from '../server-clock';

/** 仅服务端明确标记的生成资源受保留期约束，不补写旧资源或上传资源的时间。 */
export const AssetRetentionContext = createContext<ReadonlyMap<string, Asset>>(new Map());

const recordedTimeSchema = z.string().datetime({ offset: true });

function retentionTime(value: unknown) {
  const parsed = recordedTimeSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const timestamp = Date.parse(parsed.data);
  if (!Number.isFinite(timestamp)) return undefined;
  return {
    timestamp,
    dateTime: new Date(timestamp).toISOString(),
    label: new Date(timestamp).toLocaleString('zh-CN', { hour12: false }),
  };
}

/** 无有效销毁时间时不显示保留期，也不根据客户端推断历史资源的期限。 */
export function getAssetRetention(metadata?: Record<string, unknown>) {
  const expiresAt = retentionTime(metadata?.expiresAt);
  if (!expiresAt) return undefined;
  return {
    expiresAt,
    generatedAt: retentionTime(metadata?.generatedAt),
    expiredAt: retentionTime(metadata?.expiredAt),
  };
}

/** 只在下一个资源到期时刷新；后台恢复时重新校准，不逐秒重渲染整个画布。 */
export function useAssetExpiryClock(nextExpiry?: number) {
  const [now, setNow] = useState(serverClockNow);
  useEffect(() => {
    if (nextExpiry === undefined) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      clearTimeout(timer);
      const current = serverClockNow();
      setNow(current);
      if (nextExpiry !== undefined && nextExpiry > current) {
        timer = setTimeout(update, Math.min(nextExpiry - current + 1, 2_147_483_647));
      }
    };
    update();
    document.addEventListener('visibilitychange', update);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', update);
    };
  }, [nextExpiry]);
  return now;
}
