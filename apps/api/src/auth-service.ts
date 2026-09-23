import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

import { signHs256Jwt, verifyHs256Jwt, type AuthRole, type JwtClaims } from './auth';
import { type AuthSessionRecord, type AuthStore, type AuthUserRecord } from './auth-store';
const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const DEFAULT_SESSION_TTL_SECONDS = 7 * 86400;
const MAX_SESSION_TTL_SECONDS = 30 * 86400;
const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type AuthServiceOptions = {
  store: AuthStore;
  jwtSecret: string;
  accessTokenTtlSeconds?: number;
  /** 本地会话最长寿命；New API 实例仍须受上游授权到期时间约束。 */
  maxSessionTtlSeconds?: number;
  now?: () => number;
};

export type AuthPublicUser = {
  id: string;
  /** New API 未提供邮箱时省略，不生成伪造邮箱。 */
  email?: string;
  displayName?: string;
  role: AuthRole;
  createdAt: string;
  /** 账户是否已验证、禁用及个人资料的公开字段。 */
  status: AuthUserRecord['status'];
  updatedAt: string;
  bio?: string;
  avatarUrl?: string;
};

export type AuthTokenResponse = {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  expiresAt: string;
  /** Cookie 最迟保留至此；过期访问令牌只能在上游身份复核后续期。 */
  refreshExpiresAt: string;
  user: AuthPublicUser;
};

export type AuthenticatedSession = {
  user: AuthPublicUser;
  session: AuthSessionRecord;
  claims: JwtClaims;
};

export class AuthServiceError extends Error {
  constructor(
    public readonly code:
      | 'invalid_input'
      | 'email_taken'
      | 'invalid_credentials'
      | 'invalid_token'
      | 'session_revoked'
      | 'account_disabled',
    message: string,
  ) {
    super(message);
  }
}

export class AuthService {
  private readonly accessTokenTtlSeconds: number;
  private readonly maxSessionTtlSeconds: number;
  private readonly now: () => number;

  constructor(private readonly options: AuthServiceOptions) {
    if (!options.jwtSecret.trim()) throw new Error('JWT secret is required');
    const ttl = options.accessTokenTtlSeconds ?? DEFAULT_ACCESS_TOKEN_TTL_SECONDS;
    if (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > 24 * 60 * 60) {
      throw new Error('access token TTL must be between 60 and 86400 seconds');
    }
    this.accessTokenTtlSeconds = ttl;
    const sessionTtl = options.maxSessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
    if (
      !Number.isSafeInteger(sessionTtl) ||
      sessionTtl < 60 ||
      sessionTtl > MAX_SESSION_TTL_SECONDS
    )
      throw new Error('session TTL must be between 60 and 2592000 seconds');
    this.maxSessionTtlSeconds = sessionTtl;
    this.now = options.now ?? (() => Date.now());
  }

  async verifyAccessToken(accessToken: string): Promise<AuthenticatedSession> {
    const result = verifyHs256Jwt(accessToken, this.options.jwtSecret, this.now, true);
    if (!result.ok || !result.claims.sid || !SESSION_ID_PATTERN.test(result.claims.sid)) {
      throw new AuthServiceError('invalid_token', 'invalid access token');
    }

    const session = await this.options.store.findSession(result.claims.sid);
    const now = new Date(this.now());
    if (
      !session ||
      session.userId !== result.claims.sub ||
      session.revokedAt ||
      session.expiresAt.getTime() <= now.getTime() ||
      !equalHash(session.tokenHash, sha256(accessToken))
    ) {
      throw new AuthServiceError(
        session?.revokedAt ? 'session_revoked' : 'invalid_token',
        session?.revokedAt ? 'session has been revoked' : 'invalid access token',
      );
    }

    const user = await this.options.store.findUserById(session.userId);
    if (!user || user.status !== 'active')
      throw new AuthServiceError('invalid_token', 'invalid access token');
    await this.options.store.touchSession(session.id, now);
    return { user: toPublicUser(user), session, claims: result.claims };
  }

  async logout(accessToken: string): Promise<boolean> {
    try {
      const authenticated = await this.verifySessionForRefresh(accessToken);
      await this.options.store.revokeSession(authenticated.session.id, new Date(this.now()));
      return true;
    } catch (error) {
      if (error instanceof AuthServiceError) return false;
      throw error;
    }
  }

  async logoutAll(userId: string): Promise<number> {
    if (!SESSION_ID_PATTERN.test(userId))
      throw new AuthServiceError('invalid_input', 'invalid user id');
    return this.options.store.revokeAllSessions(userId, new Date(this.now()));
  }

  /**
   * 轮换短期令牌且不重放业务请求；仅调用方已复核上游授权时才传入新的最晚期限。
   * @param accessToken 当前 Cookie 内的会话令牌。
   * @param authorizedUntil 经过上游复核的授权到期时间；不能突破实例寿命上限。
   * @returns 新令牌及其 Cookie 最晚保留期限；原令牌同时撤销。
   * @throws AuthServiceError 会话撤销、账号禁用或授权期限已到。
   */
  async refresh(accessToken: string, authorizedUntil?: Date): Promise<AuthTokenResponse> {
    const current = await this.verifySessionForRefresh(accessToken);
    const absoluteExpiresAt =
      authorizedUntil ??
      current.session.absoluteExpiresAt ??
      new Date(current.session.createdAt.getTime() + DEFAULT_SESSION_TTL_SECONDS * 1000);
    if (absoluteExpiresAt.getTime() <= this.now() + 60_000)
      throw new AuthServiceError('invalid_token', 'session absolute expiry reached');
    const user = await this.options.store.findUserById(current.user.id);
    if (!user) throw new AuthServiceError('invalid_token', 'invalid access token');
    return this.options.store.transaction(async (store) => {
      const latest = await store.findSession(current.session.id);
      if (!latest || latest.revokedAt)
        throw new AuthServiceError('session_revoked', 'session has been revoked');
      const result = await this.issueToken(user, absoluteExpiresAt, store);
      await store.revokeSession(current.session.id, new Date(this.now()));
      return result;
    });
  }

  /**
   * 续期只校验签名、会话未撤销和绝对期限。
   * 访问令牌过期仍可换发，避免后台标签页冻住定时器后无法恢复登录。
   */
  async verifySessionForRefresh(accessToken: string): Promise<AuthenticatedSession> {
    const result = verifyHs256Jwt(accessToken, this.options.jwtSecret, this.now, false, true);
    if (!result.ok || !result.claims.sid || !SESSION_ID_PATTERN.test(result.claims.sid)) {
      throw new AuthServiceError('invalid_token', 'invalid access token');
    }
    const session = await this.options.store.findSession(result.claims.sid);
    if (
      !session ||
      session.userId !== result.claims.sub ||
      session.revokedAt ||
      (session.absoluteExpiresAt?.getTime() ??
        session.createdAt.getTime() + DEFAULT_SESSION_TTL_SECONDS * 1000) <= this.now() ||
      !equalHash(session.tokenHash, sha256(accessToken))
    ) {
      throw new AuthServiceError(
        session?.revokedAt ? 'session_revoked' : 'invalid_token',
        session?.revokedAt ? 'session has been revoked' : 'invalid access token',
      );
    }
    const user = await this.options.store.findUserById(session.userId);
    if (!user || user.status !== 'active')
      throw new AuthServiceError('invalid_token', 'invalid access token');
    return { user: toPublicUser(user), session, claims: result.claims };
  }

  /** 仅供完成上游身份或本地身份校验的内部服务签发会话，不接受 HTTP 用户对象。 */
  async issueToken(
    user: AuthUserRecord,
    absoluteExpiresAt = new Date(this.now() + DEFAULT_SESSION_TTL_SECONDS * 1000),
    store = this.options.store,
  ): Promise<AuthTokenResponse> {
    if (user.status !== 'active')
      throw new AuthServiceError('invalid_token', 'account is not active');
    const issuedAt = this.now();
    absoluteExpiresAt = new Date(
      Math.min(absoluteExpiresAt.getTime(), issuedAt + this.maxSessionTtlSeconds * 1000),
    );
    if (!Number.isFinite(absoluteExpiresAt.getTime()) || absoluteExpiresAt.getTime() <= issuedAt)
      throw new AuthServiceError('invalid_token', 'session absolute expiry reached');
    const expiresAt = new Date(
      Math.min(issuedAt + this.accessTokenTtlSeconds * 1000, absoluteExpiresAt.getTime()),
    );
    const sessionId = randomUUID();
    const expiresIn = Math.floor((expiresAt.getTime() - issuedAt) / 1000);
    const claims = issueClaims(user, sessionId, issuedAt, expiresIn);
    const accessToken = signHs256Jwt(claims, this.options.jwtSecret);
    await store.createSession({
      id: sessionId,
      userId: user.id,
      tokenHash: sha256(accessToken),
      expiresAt,
      absoluteExpiresAt,
    });
    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn,
      expiresAt: expiresAt.toISOString(),
      refreshExpiresAt: absoluteExpiresAt.toISOString(),
      user: toPublicUser(user),
    };
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function equalHash(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

/** 映射可公开账户资料，永远不包含密码哈希或会话材料。 */
export function toPublicUser(user: AuthUserRecord): AuthPublicUser {
  return {
    id: user.id,
    ...(user.email ? { email: user.email } : {}),
    ...(user.displayName ? { displayName: user.displayName } : {}),
    role: user.role,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
    status: user.status,
    ...(user.bio ? { bio: user.bio } : {}),
    ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
  };
}

function issueClaims(
  user: AuthUserRecord,
  sessionId: string,
  nowMs: number,
  ttl: number,
): JwtClaims {
  const nowSeconds = Math.floor(nowMs / 1000);
  return {
    sub: user.id,
    sid: sessionId,
    role: user.role,
    iat: nowSeconds,
    exp: nowSeconds + ttl,
  };
}
