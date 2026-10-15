/** Stable public explanations; never display or persist arbitrary authentication response text. */
export const AUTH_ERROR_MESSAGES = {
  authentication_required: '登录状态校验未通过，请重试；若仍失败，请重新登录',
  authentication_missing: '请求未携带登录凭证，请重新登录',
  access_token_expired: '短期登录凭证已到期，需要自动续期',
  invalid_token: '登录凭证校验失败，请重新登录',
  token_not_yet_valid: '登录凭证尚未生效，请稍后重试',
  session_required: '缺少有效登录会话，请重新登录',
  session_revoked: '本次请求的旧会话已失效，可能已被自动续期替换，请重试',
  session_expired: '登录会话已超过有效期，请重新登录',
  account_disabled: '当前账号不可用，请检查账号状态',
  authentication_unavailable: '登录服务暂时不可用，已保留当前登录状态，请稍后重试',
  upstream_unavailable: 'New API 暂时不可用，请稍后重试',
  auth_session_restored: '登录状态已自动恢复，请重试本次操作',
} as const;

export type AuthErrorCode = keyof typeof AUTH_ERROR_MESSAGES;

export function isAuthErrorCode(code: unknown): code is AuthErrorCode {
  return typeof code === 'string' && Object.hasOwn(AUTH_ERROR_MESSAGES, code);
}
