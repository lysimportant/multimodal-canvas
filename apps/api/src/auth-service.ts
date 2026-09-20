import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

import { signHs256Jwt, verifyHs256Jwt, type AuthRole, type JwtClaims } from './auth';
import { type AuthSessionRecord, type AuthStore, type AuthUserRecord } from './auth-store';
const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type AuthServiceOptions = {
  store: AuthStore;
  jwtSecret: string;
  accessTokenTtlSeconds?: number;
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
  private readonly now: () => number;

  constructor(private readonly options: AuthServiceOptions) {
    if (!options.jwtSecret.trim()) throw new Error('JWT secret is required');
    const ttl = options.accessTokenTtlSeconds ?? DEFAULT_ACCESS_TOKEN_TTL_SECONDS;
    if (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > 24 * 60 * 60) {
      throw new Error('access token TTL must be between 60 and 86400 seconds');
    }
    this.accessTokenTtlSeconds = ttl;
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
      const authenticated = await this.verifyAccessToken(accessToken);
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

  /** 续期原子轮换会话并撤销旧令牌，绝对期限不会随着续期延长。 */
  async refresh(accessToken: string): Promise<AuthTokenResponse> {
    const current = await this.verifySessionForRefresh(accessToken);
    const absoluteExpiresAt =
      current.session.absoluteExpiresAt ??
      new Date(current.session.createdAt.getTime() + 7 * 24 * 60 * 60 * 1000);
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
      (session.absoluteExpiresAt?.getTime() ?? session.createdAt.getTime() + 604800000) <=
        this.now() ||
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
    absoluteExpiresAt = new Date(this.now() + 7 * 24 * 60 * 60 * 1000),
    store = this.options.store,
  ): Promise<AuthTokenResponse> {
    if (user.status !== 'active')
      throw new AuthServiceError('invalid_token', 'account is not active');
    const issuedAt = this.now();
    absoluteExpiresAt = new Date(Math.min(absoluteExpiresAt.getTime(), issuedAt + 604800000));
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
