import { useCallback, useEffect, useRef } from 'react';
import { useWorkspacePreferences } from '../state/workspace-preferences';

/** 自动分析只提示当前成功回显资源；付费请求必须到反推面板确认报价。 */
type ReadyResource = { assetId: string; version?: number; label: string };

/** 付费自动反推暂停为手动确认，每个资源版本只提醒一次，绝不自动发送生成 POST。 */
export function useAutomaticReversePrompt(
  projectId: string | null,
  userId: string | undefined,
  onError: (message: string) => void,
) {
  const attempted = useRef(new Set<string>());
  const context = useRef({ projectId, userId, active: true });
  context.current = { projectId, userId, active: true };
  const notify = useRef(onError);
  notify.current = onError;
  useEffect(() => {
    context.current.active = true;
    attempted.current.clear();
    return () => {
      context.current.active = false;
    };
  }, [projectId, userId]);
  return useCallback(
    (resource: ReadyResource) => {
      if (
        !projectId ||
        !userId ||
        !context.current.active ||
        context.current.projectId !== projectId ||
        context.current.userId !== userId ||
        !useWorkspacePreferences.getState().autoReversePrompt
      )
        return;
      const key = `${projectId}:${resource.assetId}:${resource.version ?? 'current'}`;
      if (attempted.current.has(key)) return;
      attempted.current.add(key);
      notify.current(`${resource.label}：反推需要确认费用，请在资源反推面板选择模型并确认报价`);
    },
    [projectId, userId],
  );
}
