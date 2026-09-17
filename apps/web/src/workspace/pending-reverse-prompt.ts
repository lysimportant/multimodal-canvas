import { z } from 'zod';

import type { ReversePromptTarget } from '../reverse-prompts';

/** 待确认提交只保存非敏感请求身份和模型引用，不保存资源正文或凭据密钥。 */
const pendingReversePromptSchema = z.object({
  key: z.string().min(1),
  model: z
    .object({ modelAlias: z.string().min(1), credentialId: z.string().optional() })
    .optional(),
});

/** 关闭或刷新 Dialog 后仍沿用的手动请求身份；收到明确响应才清除。 */
export type PendingReversePrompt = z.infer<typeof pendingReversePromptSchema>;

/** 为当前标签页的用户、项目与资源版本隔离待确认身份。 */
export function pendingReversePromptKey(userId: string, target: ReversePromptTarget): string {
  return `multimodal-canvas:pending-reverse:${JSON.stringify([userId, target.projectId, target.assetId, target.version])}`;
}

/** 读取未确认请求；存储不可用或内容损坏时抛错，防止误用新键重复提交。 */
export function readPendingReversePrompt(key: string): PendingReversePrompt | undefined {
  const stored = sessionStorage.getItem(key);
  if (stored === null) return undefined;
  const parsed = pendingReversePromptSchema.safeParse(JSON.parse(stored));
  if (!parsed.success) throw new Error('待确认反推请求记录无效');
  return parsed.data;
}

/** 提交前持久化身份；清除时核对原键，避免旧响应清掉新请求。 */
export function savePendingReversePrompt(storageKey: string, pending: PendingReversePrompt): void {
  sessionStorage.setItem(storageKey, JSON.stringify(pending));
}

/** 仅清除当前已确认的请求，其他窗口或迟到响应不会替换新身份。 */
export function clearPendingReversePrompt(storageKey: string, requestKey: string): void {
  if (readPendingReversePrompt(storageKey)?.key === requestKey)
    sessionStorage.removeItem(storageKey);
}
