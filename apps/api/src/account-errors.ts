import { AuthServiceError } from './auth-service';
import { AuthStoreError } from './auth-store';

/** 资源、会话和审计管理的稳定拒绝，不泄露底层数据库异常。 */
export class AccountAccessError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
  }
}

/** 已知管理错误映射为公开 HTTP 响应，其余交给全局错误边界。 */
export function accountError(
  error: unknown,
): { status: number; body: { code: string; error: string } } | undefined {
  if (error instanceof AccountAccessError)
    return { status: error.statusCode, body: { code: error.code, error: error.message } };
  if (error instanceof AuthServiceError || error instanceof AuthStoreError)
    return { status: 400, body: { code: error.code, error: error.message } };
  return undefined;
}
