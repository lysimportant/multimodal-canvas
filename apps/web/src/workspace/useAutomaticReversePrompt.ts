import { useCallback, useEffect, useRef } from 'react';

import { fetchAssetVersions } from '../result-versions';
import { apiFetch } from '../auth-client';
import { fetchReversePrompt, submitReversePrompt } from '../reverse-prompts';
import { useWorkspacePreferences } from '../state/workspace-preferences';
import { API_BASE_URL } from './contracts';

/** 自动分析只接收已经成功回显的资源身份，不扫描历史画布。 */
type ReadyResource = { assetId: string; version?: number; label: string };

/**
 * 返回成功回显事件的自动反推入口；开关默认关闭，按项目与精确版本去重。
 * 仅轮询已提交任务，POST 失败不重发；切换项目或账户停止本地等待，不取消远端执行。
 */
export function useAutomaticReversePrompt(
  projectId: string | null,
  userId: string | undefined,
  onError: (message: string) => void,
) {
  const lifecycle = useRef<{
    controller: AbortController;
    projectId: string | null;
    userId: string | undefined;
  }>(undefined);
  const attempted = useRef(new Set<string>());
  const notify = useRef(onError);
  notify.current = onError;
  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = { controller, projectId, userId };
    attempted.current.clear();
    return () => controller.abort();
  }, [projectId, userId]);

  return useCallback(
    (resource: ReadyResource) => {
      const scope = lifecycle.current;
      const controller = scope?.controller;
      if (
        !projectId ||
        !userId ||
        !controller ||
        scope?.projectId !== projectId ||
        scope?.userId !== userId ||
        controller.signal.aborted ||
        !useWorkspacePreferences.getState().autoReversePrompt
      )
        return;
      const identity = `${projectId}:${resource.assetId}:${resource.version ?? 'current'}`;
      if (attempted.current.has(identity)) return;
      attempted.current.add(identity);
      void (async () => {
        const version =
          resource.version ??
          (await fetchAssetVersions(resource.assetId, API_BASE_URL, apiFetch)).at(-1)?.version;
        if (controller.signal.aborted || !useWorkspacePreferences.getState().autoReversePrompt)
          return;
        if (!version) throw new Error('资源版本未记录');
        const resolvedIdentity = `${projectId}:${resource.assetId}:${version}`;
        if (resolvedIdentity !== identity && attempted.current.has(resolvedIdentity)) return;
        attempted.current.add(resolvedIdentity);
        const target = { projectId, assetId: resource.assetId, version };
        let analysis = await submitReversePrompt(target, API_BASE_URL, {
          automatic: true,
          idempotencyKey: `automatic:${resource.assetId}:${version}`,
        });
        while (
          !controller.signal.aborted &&
          (analysis.status === 'queued' || analysis.status === 'running')
        ) {
          await new Promise<void>((resolve) => {
            const done = () => {
              window.clearTimeout(timer);
              controller.signal.removeEventListener('abort', done);
              resolve();
            };
            const timer = window.setTimeout(done, 1500);
            controller.signal.addEventListener('abort', done, { once: true });
            if (controller.signal.aborted) done();
          });
          if (controller.signal.aborted) return;
          const next = await fetchReversePrompt(target, API_BASE_URL, {
            runId: analysis.runId,
            signal: controller.signal,
          });
          if (!next.analysis) throw new Error('反推任务未找到');
          analysis = next.analysis;
        }
        if (analysis.status === 'failed' && !controller.signal.aborted)
          throw new Error(analysis.error ?? '反推失败');
      })().catch((error: unknown) => {
        if (!controller.signal.aborted)
          notify.current(
            `${resource.label}：自动反推失败，${error instanceof Error ? error.message : '请求失败'}`,
          );
      });
    },
    [projectId, userId],
  );
}
