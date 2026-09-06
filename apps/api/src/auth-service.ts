import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

import { signHs256Jwt, verifyHs256Jwt, type AuthRole, type JwtClaims } from './auth';
import {
  AuthStoreError,
  type AuthSessionRecord,
  type AuthStore,
  type AuthUserRecord,
} from './auth-store';

const scryptAsync = promisify(scryptCallback) as unknown as (
  password: string | Buffer,
  salt: string | Buffer,
  keyLength: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const SCRYPT_VERSION = 1;
const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_SALT_LENGTH = 16;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_BYTES = 512;
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
  email: string;
  displayName?: string;
  role: AuthRole;
  createdAt: string;
  /** 账户是否已验证、禁用及个人资料的公开字段。 */
  status: AuthUserRecord['status'];
  updatedAt: string;
  bio?: string;
  avatarUrl?: string;
  emailVerifiedAt?: string;
};

export type AuthTokenResponse = {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  expiresAt: string;
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
      | 'email_verification_required'
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

  async register(input: {
    email: string;
    password: string;
    displayName?: string;
  }): Promise<AuthTokenResponse> {
    const email = validateEmail(input.email);
    validatePassword(input.password);
    const passwordHash = await hashPassword(input.password);
    let user: AuthUserRecord;
    try {
      user = await this.options.store.createUser({
        email,
        passwordHash,
        ...(input.displayName?.trim() ? { displayName: input.displayName.trim() } : {}),
      });
    } catch (error) {
      if (error instanceof AuthStoreError && error.code === 'email_taken') {
        throw new AuthServiceError('email_taken', 'email is already registered');
      }
      throw error;
    }
    return this.issueToken(user);
  }

  async login(input: { email: string; password: string }): Promise<AuthTokenResponse> {
    const email = normalizeEmail(input.email);
    if (!EMAIL_PATTERN.test(email) || !input.password) {
      await verifyPassword(input.password || 'invalid', await getDummyPasswordHash());
      throw new AuthServiceError('invalid_credentials', 'invalid email or password');
    }

    const user = await this.options.store.findUserByEmail(email);
    const passwordHash = user?.passwordHash ?? (await getDummyPasswordHash());
    let valid = await verifyPassword(input.password, passwordHash);
    // Legacy rows may have no password hash (or a malformed value). Perform
    // the same dummy KDF before returning so account existence is not exposed
    // through an obviously shorter failure path.
    if (user && !parsePasswordHash(passwordHash)) {
      valid = await verifyPassword(input.password, await getDummyPasswordHash());
    }
    if (!user || !valid) {
      throw new AuthServiceError('invalid_credentials', 'invalid email or password');
    }
    if (user.status === 'disabled')
      throw new AuthServiceError('account_disabled', '账户已禁用，请联系管理员');
    if (user.status === 'pending')
      throw new AuthServiceError('email_verification_required', '请先完成邮箱验证');
    return this.issueToken(user);
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

  /** 有效会话可主动续期，绝对期限七天；旧令牌保留到原到期时间以容纳在途请求。 */
  async refresh(accessToken: string): Promise<AuthTokenResponse> {
    const current = await this.verifyAccessToken(accessToken);
    const absoluteExpiresAt =
      current.session.absoluteExpiresAt ??
      new Date(current.session.createdAt.getTime() + 7 * 24 * 60 * 60 * 1000);
    if (absoluteExpiresAt.getTime() <= this.now() + 60_000)
      throw new AuthServiceError('invalid_token', 'session absolute expiry reached');
    const user = await this.options.store.findUserById(current.user.id);
    if (!user) throw new AuthServiceError('invalid_token', 'invalid access token');
    return this.issueToken(user, absoluteExpiresAt);
  }

  /** 仅供完成密码或邮箱所有权校验的内部服务签发会话，不接受 HTTP 用户对象。 */
  async issueToken(
    user: AuthUserRecord,
    absoluteExpiresAt = new Date(this.now() + 7 * 24 * 60 * 60 * 1000),
  ): Promise<AuthTokenResponse> {
    if (user.status !== 'active')
      throw new AuthServiceError('invalid_token', 'account is not active');
    const issuedAt = this.now();
    const expiresAt = new Date(
      Math.min(issuedAt + this.accessTokenTtlSeconds * 1000, absoluteExpiresAt.getTime()),
    );
    const sessionId = randomUUID();
    const claims = issueClaims(user, sessionId, issuedAt, this.accessTokenTtlSeconds);
    const accessToken = signHs256Jwt(claims, this.options.jwtSecret);
    await this.options.store.createSession({
      id: sessionId,
      userId: user.id,
      tokenHash: sha256(accessToken),
      expiresAt,
      absoluteExpiresAt,
    });
    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: this.accessTokenTtlSeconds,
      expiresAt: expiresAt.toISOString(),
      user: toPublicUser(user),
    };
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function validateEmail(email: string): string {
  const normalized = normalizeEmail(email);
  if (normalized.length > 320 || !EMAIL_PATTERN.test(normalized)) {
    throw new AuthServiceError('invalid_input', 'invalid email');
  }
  return normalized;
}

export function validatePassword(password: string): void {
  if (
    typeof password !== 'string' ||
    password.length < PASSWORD_MIN_LENGTH ||
    Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES
  ) {
    throw new AuthServiceError('invalid_input', 'password must be 8-512 bytes');
  }
}

export async function hashPassword(password: string): Promise<string> {
  validatePassword(password);
  const salt = randomBytes(SCRYPT_SALT_LENGTH);
  const derived = await derivePassword(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return [
    'scrypt',
    SCRYPT_VERSION,
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parsed = parsePasswordHash(encoded);
  if (!parsed || typeof password !== 'string') return false;
  const derived = await derivePassword(password, parsed.salt, parsed.N, parsed.r, parsed.p);
  return equalHash(derived.toString('base64url'), parsed.hash.toString('base64url'));
}

function parsePasswordHash(encoded: string):
  | {
      salt: Buffer;
      hash: Buffer;
      N: number;
      r: number;
      p: number;
    }
  | undefined {
  const parts = encoded.split('$');
  if (parts.length !== 7 || parts[0] !== 'scrypt' || parts[1] !== String(SCRYPT_VERSION))
    return undefined;
  const N = Number(parts[2]);
  const r = Number(parts[3]);
  const p = Number(parts[4]);
  if (
    !Number.isSafeInteger(N) ||
    !Number.isSafeInteger(r) ||
    !Number.isSafeInteger(p) ||
    N < 16_384 ||
    N > 131_072 ||
    (N & (N - 1)) !== 0 ||
    r < 1 ||
    r > 32 ||
    p < 1 ||
    p > 8
  ) {
    return undefined;
  }
  let salt: Buffer;
  let hash: Buffer;
  try {
    salt = Buffer.from(parts[5], 'base64url');
    hash = Buffer.from(parts[6], 'base64url');
  } catch {
    return undefined;
  }
  if (salt.length !== SCRYPT_SALT_LENGTH || hash.length !== SCRYPT_KEY_LENGTH) return undefined;
  return { salt, hash, N, r, p };
}

async function derivePassword(
  password: string,
  salt: Buffer,
  N: number,
  r: number,
  p: number,
): Promise<Buffer> {
  return scryptAsync(password, salt, SCRYPT_KEY_LENGTH, {
    N,
    r,
    p,
    maxmem: SCRYPT_MAX_MEMORY,
  });
}

let dummyPasswordHashPromise: Promise<string> | undefined;
function getDummyPasswordHash(): Promise<string> {
  dummyPasswordHashPromise ??= hashPassword('invalid-user-password');
  return dummyPasswordHashPromise;
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
    email: user.email,
    ...(user.displayName ? { displayName: user.displayName } : {}),
    role: user.role,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
    status: user.status,
    ...(user.bio ? { bio: user.bio } : {}),
    ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
    ...(user.emailVerifiedAt ? { emailVerifiedAt: user.emailVerifiedAt.toISOString() } : {}),
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
