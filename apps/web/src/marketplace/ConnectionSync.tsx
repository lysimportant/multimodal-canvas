import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getAuthSessionGeneration } from '../auth-client';
import { managementRequest } from '../management/client';

/** 连接同步只返回数量与业务阻塞原因，Key 由服务端读取。 */
export type ConnectionSyncResult = {
  connections: Array<{
    id: string;
    published: number;
    retained: number;
    issues: Array<{ modelId?: string; message: string }>;
  }>;
};

/** 管理员同步指定或全部连接后刷新画布、广场和后台，账户切换后不回填旧结果。 */
export function useSyncConnections() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (credentialId?: string) =>
      managementRequest<ConnectionSyncResult>('/admin/model-marketplace/connections/sync', {
        method: 'POST',
        body: { ...(credentialId ? { credentialId } : {}) },
      }),
    onMutate: () => getAuthSessionGeneration(),
    onSuccess: async (_result, _id, generation) => {
      if (getAuthSessionGeneration() !== generation) throw new Error('账户已切换，请重新操作');
      await Promise.all([
        client.invalidateQueries({ queryKey: ['platform-model-catalog'] }),
        client.invalidateQueries({ queryKey: ['marketplace'] }),
        client.invalidateQueries({ queryKey: ['management'] }),
      ]);
    },
  });
}

/** 显示每条连接的同步结果；部分上架仍列出全部未上架原因。 */
export function ConnectionSyncNotice({
  result,
  error,
  labels,
}: {
  result?: ConnectionSyncResult;
  error?: Error | null;
  labels: Record<string, string>;
}) {
  if (error) return <p role="alert">画布模型同步失败：{error.message}。连接已保留，可重试同步。</p>;
  if (!result) return null;
  return (
    <div aria-live="polite" aria-label="画布模型同步结果">
      {!result.connections.length && <p>暂无已保存连接，请先添加 Key。</p>}
      {result.connections.map((connection) => (
        <div key={connection.id}>
          <p>
            {labels[connection.id] ?? '连接'}：{connection.published} 个模型已同步到画布
            {connection.retained ? `，${connection.retained} 个保留原状态或暂不可用` : ''}
          </p>
          {!!connection.issues.length && (
            <ul>
              {connection.issues.map((issue, index) => (
                <li key={index}>
                  {issue.modelId ? `${issue.modelId}：` : ''}
                  {issue.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}
