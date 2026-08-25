import { createHmac, timingSafeEqual } from 'node:crypto';

export type AuthRole = 'user' | 'admin';

/** The authenticated caller attached to a request. */
export type AuthPrincipal = {
  /** Stable application user identifier from `sub` or `user_id`. */
  userId?: string;
  /** `api-token` is a service credential without user-level scope. */
  method: 'anonymous' | 'api-token' | 'jwt';
  /** Role is only an assertion; stateful callers must resolve the current user. */
  role?: AuthRole;
  /** Stateful access-token session id, when present in the JWT. */
  sessionId?: string;
};

export type JwtClaims = {
  sub: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  sid?: string;
  role?: AuthRole;
};

export type JwtVerificationResult =
  | { ok: true; claims: JwtClaims }
  | { ok: false; reason: 'missing' | 'invalid' | 'expired' | 'not-yet-valid' };

export type AuthenticationOptions = {
  apiToken?: string;
  jwtSecret?: string;
  /** Reject JWTs without an exp claim when the deployment requires short-lived tokens. */
  requireExpiration?: boolean;
  now?: () => number;
};

export type AuthenticationResult =
  | { ok: true; principal: AuthPrincipal }
  | { ok: false; reason: 'missing' | 'invalid' | 'expired' | 'not-yet-valid' };

const MAX_TOKEN_BYTES = 16 * 1024;
// User ids are persisted in PostgreSQL UUID foreign-key columns. Accepting an
// arbitrary external id (for example `486`) would authenticate successfully
// and only fail later, or accidentally bypass owner scoping in a fallback
// store. Require the canonical UUID representation at the auth boundary.
const USER_ID_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Authenticate a Bearer token without bringing a second JWT dependency into
 * the API. Static API tokens remain supported for local service-to-service
 * use; JWTs are only accepted when an explicit secret is configured.
 */
export function authenticateBearer(
  authorization: string | undefined,
  options: AuthenticationOptions,
): AuthenticationResult {
  const token = extractBearerToken(authorization);
  if (!token) return { ok: false, reason: 'missing' };
  if (Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) {
    return { ok: false, reason: 'invalid' };
  }

  if (options.apiToken && safeEqual(token, options.apiToken)) {
    return { ok: true, principal: { method: 'api-token' } };
  }

  if (!options.jwtSecret) return { ok: false, reason: 'invalid' };
  const verified = verifyHs256Jwt(
    token,
    options.jwtSecret,
    options.now ?? (() => Date.now()),
    options.requireExpiration ?? false,
  );
  if (!verified.ok) return verified;
  return {
    ok: true,
    principal: {
      method: 'jwt',
      userId: verified.claims.sub,
      ...(verified.claims.role ? { role: verified.claims.role } : {}),
      ...(verified.claims.sid ? { sessionId: verified.claims.sid } : {}),
    },
  };
}

export function extractBearerToken(authorization: string | undefined): string | undefined {
  if (!authorization || !/^Bearer\s+/i.test(authorization)) return undefined;
  const token = authorization.replace(/^Bearer\s+/i, '').trim();
  return token || undefined;
}

export function verifyHs256Jwt(
  token: string,
  secret: string,
  now: () => number,
  requireExpiration: boolean,
): JwtVerificationResult {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'invalid' };

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = parseJsonPart(parts[0]);
    payload = parseJsonPart(parts[1]);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (header.alg !== 'HS256' || (header.typ !== undefined && header.typ !== 'JWT')) {
    return { ok: false, reason: 'invalid' };
  }

  const expected = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(parts[2], 'base64url');
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: 'invalid' };
  }

  const nowSeconds = Math.floor(now() / 1000);
  const expiresAt = numericClaim(payload.exp);
  if (requireExpiration && expiresAt === undefined) return { ok: false, reason: 'invalid' };
  if (expiresAt !== undefined && nowSeconds >= expiresAt) return { ok: false, reason: 'expired' };
  const notBefore = numericClaim(payload.nbf);
  if (notBefore !== undefined && nowSeconds < notBefore) {
    return { ok: false, reason: 'not-yet-valid' };
  }

  const rawUserId =
    typeof payload.sub === 'string' && payload.sub.trim()
      ? payload.sub
      : typeof payload.user_id === 'string' && payload.user_id.trim()
        ? payload.user_id
        : typeof payload.user_id === 'number' && Number.isFinite(payload.user_id)
          ? String(payload.user_id)
          : undefined;
  const userId = rawUserId?.trim();
  if (!userId || !USER_ID_UUID_PATTERN.test(userId)) return { ok: false, reason: 'invalid' };
  const role = payload.role === 'admin' || payload.role === 'user' ? payload.role : undefined;
  const sessionId =
    typeof payload.sid === 'string' && payload.sid.trim() ? payload.sid.trim() : undefined;
  return {
    ok: true,
    claims: {
      sub: userId,
      ...(expiresAt !== undefined ? { exp: expiresAt } : {}),
      ...(notBefore !== undefined ? { nbf: notBefore } : {}),
      ...(numericClaim(payload.iat) !== undefined ? { iat: numericClaim(payload.iat) } : {}),
      ...(sessionId ? { sid: sessionId } : {}),
      ...(role ? { role } : {}),
    },
  };
}

/** Sign a compact HS256 JWT for the first-party authentication service. */
export function signHs256Jwt(claims: JwtClaims, secret: string): string {
  if (!secret.trim()) throw new Error('JWT secret is required');
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode(claims);
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function parseJsonPart(part: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('object required');
  return parsed as Record<string, unknown>;
}

function numericClaim(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
