import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  AuthService,
  AuthServiceError,
  hashPassword,
  toPublicUser,
  validateEmail,
  verifyPassword,
  type AuthTokenResponse,
} from './auth-service';
import {
  AuthStoreError,
  type AuthStore,
  type AuthUserRecord,
  type EmailChallengeRecord,
  type EmailDeliveryRecord,
  type UpdateAuthUserInput,
  type VerificationPurpose,
} from './auth-store';
import type { AccountMailSender } from './account-mail';

/** 账户工作流的稳定错误，HTTP 层不暴露底层 SMTP 或数据库异常。 */
export class AccountServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
  }
}

/** 邮件挑战成功创建并尝试交付后的公开结果。 */
export type VerificationResponse = {
  verificationRequired: true;
  email: string;
  delivery: { id: string; status: EmailDeliveryRecord['status'] };
};

/** 首次初始化、用户邀请、个人安全与审计的共享业务实现。 */
export class AccountService {
  /** 时间源可注入，便于验证过期、重发和并发消费。 */
  private readonly now: () => number;

  constructor(
    private readonly options: {
      store: AuthStore;
      auth: AuthService;
      mail: AccountMailSender;
      secret: string;
      setupToken?: string;
      now?: () => number;
    },
  ) {
    this.now = options.now ?? Date.now;
  }

  /** 初始化状态始终来自存储；已有管理员兼容写入永久标记。 */
  async bootstrapStatus() {
    return {
      initialized: await this.options.store.transaction((store) => store.bootstrapInitialized()),
      mailConfigured: this.options.mail.configured,
      setupTokenRequired: Boolean(this.options.setupToken),
    };
  }

  /** 发出第一位管理员验证挑战；密码只保存安全哈希，尚不创建可登录账户。 */
  async requestBootstrap(input: {
    email: string;
    password: string;
    displayName?: string;
    setupToken?: string;
  }): Promise<VerificationResponse> {
    this.requireMail();
    if (this.options.setupToken && !constantEqual(this.options.setupToken, input.setupToken ?? ''))
      throw new AccountServiceError('invalid_setup_token', '初始化凭据不正确', 403);
    const email = validateEmail(input.email);
    const passwordHash = await hashPassword(input.password);
    return this.requestChallenge(
      {
        email,
        purpose: 'bootstrap',
        payload: { passwordHash, ...(input.displayName ? { displayName: input.displayName } : {}) },
      },
      async (store) => {
        if (await store.bootstrapInitialized())
          throw new AccountServiceError('already_initialized', '管理员已初始化，请登录', 409);
        if (await store.findUserByEmail(email))
          throw new AccountServiceError(
            'email_taken',
            '该邮箱已有账户，请使用另一邮箱或联系部署管理员',
            409,
          );
      },
    );
  }

  /** 公开注册保留入口，但新增账户必须完成邮件验证才能获得会话。 */
  async register(input: {
    email: string;
    password: string;
    displayName?: string;
  }): Promise<VerificationResponse> {
    this.requireMail();
    const email = validateEmail(input.email);
    const passwordHash = await hashPassword(input.password);
    return this.requestChallenge(
      { email, purpose: 'register', payload: {} },
      async (store, challenge) => {
        if (await store.findUserByEmail(email))
          throw new AccountServiceError('email_taken', '邮箱已注册，请登录或重发验证邮件', 409);
        const user = await store.createUser({
          email,
          passwordHash,
          displayName: input.displayName,
          status: 'pending',
        });
        challenge.userId = user.id;
        await this.audit(store, 'user.register', user.id, user.id, '创建待验证账户', user.id);
      },
    );
  }

  /** 管理员只能邀请普通用户，验证前不会生成业务会话。 */
  async invite(actorId: string, input: { email: string; displayName?: string; bio?: string }) {
    this.requireMail();
    const email = validateEmail(input.email);
    const passwordHash = await hashPassword(randomUUID());
    let created: AuthUserRecord | undefined;
    const response = await this.requestChallenge(
      { email, purpose: 'invite', payload: {} },
      async (store, challenge) => {
        if (await store.findUserByEmail(email))
          throw new AccountServiceError('email_taken', '邮箱已注册', 409);
        created = await store.createUser({
          email,
          passwordHash,
          displayName: input.displayName,
          bio: input.bio,
          status: 'pending',
          role: 'user',
        });
        challenge.userId = created.id;
        await this.audit(
          store,
          'user.invite',
          actorId,
          created.id,
          '管理员创建待激活普通用户',
          created.id,
        );
      },
    );
    return { ...response, user: toPublicUser(created!) };
  }

  /** 受重发间隔限制的挑战替换；已消费或不属于受限账户的挑战不能复用。 */
  async resend(
    emailInput: string,
    purpose: VerificationPurpose,
    actorId?: string,
  ): Promise<VerificationResponse> {
    this.requireMail();
    const email = validateEmail(emailInput);
    const previous = await this.options.store.findChallenge(email, purpose);
    if (!previous)
      throw new AccountServiceError('verification_unavailable', '没有可重发的验证申请，请重新开始');
    if (purpose === 'email' || purpose === 'reset')
      throw new AccountServiceError(
        'verification_unavailable',
        '请在账户安全页面或用户管理中重新申请',
      );
    return this.requestChallenge(
      { email, purpose, userId: previous.userId, payload: previous.payload },
      async (store) => {
        if (purpose === 'bootstrap' && (await store.bootstrapInitialized()))
          throw new AccountServiceError('already_initialized', '管理员已初始化', 409);
        if (previous.userId) {
          const user = await this.requireUser(store, previous.userId);
          if (user.status !== 'pending')
            throw new AccountServiceError('verification_unavailable', '当前账户无需激活或已被禁用');
          if (actorId)
            await this.audit(
              store,
              'user.invite.resend',
              actorId,
              user.id,
              '重新发送激活邮件',
              user.id,
            );
        }
      },
    );
  }

  /** 原子校验和消费邮箱验证码；失败尝试会提交，避免回滚绕过五次限制。 */
  async verify(
    input: { email: string; code: string; purpose: VerificationPurpose; password?: string },
    authenticatedUserId?: string,
  ): Promise<AuthTokenResponse> {
    const email = validateEmail(input.email);
    let suppliedPasswordHash: string | undefined;
    if (input.purpose === 'invite' || input.purpose === 'reset')
      suppliedPasswordHash = await hashPassword(input.password ?? '');
    const result = await this.options.store.transaction(async (store) => {
      const challenge = await store.findChallenge(email, input.purpose);
      if (
        !challenge ||
        challenge.consumedAt ||
        challenge.expiresAt.getTime() <= this.now() ||
        challenge.attempts >= 5
      )
        return {
          error: new AccountServiceError(
            'verification_expired',
            '验证码已过期、已使用或尝试次数过多，请重新获取',
          ),
        };
      if (input.purpose === 'email' && challenge.userId !== authenticatedUserId)
        return {
          error: new AccountServiceError(
            'authentication_required',
            '请先登录正在更换邮箱的账户',
            401,
          ),
        };
      if (!constantEqual(challenge.codeHash, this.codeHash(email, input.purpose, input.code))) {
        challenge.attempts += 1;
        await store.saveChallenge(challenge);
        return {
          error: new AccountServiceError(
            'invalid_verification_code',
            `验证码不正确，剩余 ${Math.max(0, 5 - challenge.attempts)} 次尝试`,
          ),
        };
      }
      let user: AuthUserRecord;
      if (input.purpose === 'bootstrap') {
        if (await store.bootstrapInitialized())
          return {
            error: new AccountServiceError('already_initialized', '管理员已初始化，请登录', 409),
          };
        if (await store.findUserByEmail(email))
          return { error: new AccountServiceError('email_taken', '邮箱已经被使用', 409) };
        user = await store.createUser({
          email,
          passwordHash: challenge.payload.passwordHash,
          displayName: challenge.payload.displayName,
          role: 'admin',
          status: 'active',
          emailVerifiedAt: new Date(this.now()),
        });
        await store.markBootstrapInitialized();
      } else {
        user = await this.requireUser(store, challenge.userId ?? '');
        if (user.status === 'disabled')
          return { error: new AccountServiceError('account_disabled', '账户已禁用', 403) };
        if (['invite', 'register'].includes(input.purpose) && user.status !== 'pending')
          return {
            error: new AccountServiceError('verification_unavailable', '账户已经激活，请登录', 409),
          };
        if (input.purpose === 'email') {
          const taken = await store.findUserByEmail(email);
          if (taken && taken.id !== user.id)
            return { error: new AccountServiceError('email_taken', '该邮箱已被使用', 409) };
          user = await store.updateUser(user.id, { email, emailVerifiedAt: new Date(this.now()) });
        } else {
          user = await store.updateUser(user.id, {
            status: 'active',
            emailVerifiedAt: new Date(this.now()),
            ...(suppliedPasswordHash ? { passwordHash: suppliedPasswordHash } : {}),
          });
        }
        await store.revokeAllSessions(user.id, new Date(this.now()));
        await store.invalidateChallenges(user.id, new Date(this.now()));
      }
      challenge.consumedAt = new Date(this.now());
      await store.saveChallenge(challenge);
      await this.audit(
        store,
        `account.verify.${input.purpose}`,
        user.id,
        user.id,
        '完成邮箱所有权验证',
        user.id,
      );
      return { user };
    });
    if (result.error) throw result.error;
    return this.options.auth.issueToken(result.user!);
  }

  /** 修改业务资料；邮箱、密码和角色必须通过专用安全流程。 */
  async updateProfile(
    actorId: string,
    targetId: string,
    input: Pick<UpdateAuthUserInput, 'displayName' | 'bio' | 'avatarUrl'>,
  ) {
    return this.options.store.transaction(async (store) => {
      await this.requireUser(store, targetId);
      const user = await store.updateUser(targetId, input);
      await this.audit(
        store,
        'account.profile.update',
        actorId,
        targetId,
        `修改资料字段：${Object.keys(input).join('、')}`,
        targetId,
      );
      return toPublicUser(user);
    });
  }

  /** 禁用立即撤销全部会话，恢复待验证用户仍保持待验证状态。 */
  async updateUser(
    actorId: string,
    targetId: string,
    input: Pick<UpdateAuthUserInput, 'displayName' | 'bio' | 'avatarUrl' | 'status'>,
  ) {
    return this.options.store.transaction(async (store) => {
      const previous = await this.requireUser(store, targetId);
      if (input.status === 'disabled' && previous.role === 'admin') {
        const admins = (await store.listUsers()).filter(
          (user) => user.role === 'admin' && user.status === 'active',
        );
        if (admins.length <= 1 && previous.status === 'active')
          throw new AccountServiceError('last_admin', '不能禁用最后一位有效管理员', 409);
      }
      const update = { ...input };
      if (input.status === 'active' && previous.verificationRequired && !previous.emailVerifiedAt)
        update.status = 'pending';
      const user = await store.updateUser(targetId, update);
      if (input.status === 'disabled') {
        await store.revokeAllSessions(targetId, new Date(this.now()));
        await store.invalidateChallenges(targetId, new Date(this.now()));
      }
      await this.audit(
        store,
        'user.update',
        actorId,
        targetId,
        `更新用户字段：${Object.keys(input).join('、')}`,
        targetId,
      );
      return toPublicUser(user);
    });
  }

  /** 当前密码验证通过后更换密码并撤销所有旧会话，再发放当前会话。 */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<AuthTokenResponse> {
    const passwordHash = await hashPassword(newPassword);
    const user = await this.options.store.transaction(async (store) => {
      const previous = await this.requireUser(store, userId);
      if (!previous.passwordHash || !(await verifyPassword(currentPassword, previous.passwordHash)))
        throw new AccountServiceError('invalid_current_password', '当前密码不正确');
      const next = await store.updateUser(userId, { passwordHash });
      await store.revokeAllSessions(userId, new Date(this.now()));
      await store.invalidateChallenges(userId, new Date(this.now()));
      await this.audit(
        store,
        'account.password.update',
        userId,
        userId,
        '修改密码并撤销旧会话',
        userId,
      );
      return next;
    });
    return this.options.auth.issueToken(user);
  }

  /** 发送新邮箱验证，消费前保留旧邮箱；管理员也不能跳过所有权验证。 */
  async requestEmailChange(
    actorId: string,
    targetId: string,
    emailInput: string,
    currentPassword?: string,
  ): Promise<VerificationResponse> {
    const email = validateEmail(emailInput);
    return this.requestChallenge(
      { email, purpose: 'email', userId: targetId, payload: {} },
      async (store) => {
        const user = await this.requireUser(store, targetId);
        if (
          actorId === targetId &&
          (!user.passwordHash || !(await verifyPassword(currentPassword ?? '', user.passwordHash)))
        )
          throw new AccountServiceError('invalid_current_password', '当前密码不正确');
        const taken = await store.findUserByEmail(email);
        if (taken && (taken.id !== targetId || taken.emailVerifiedAt))
          throw new AccountServiceError('email_taken', '该邮箱已绑定', 409);
        await this.audit(
          store,
          'account.email.request',
          actorId,
          targetId,
          '申请验证邮箱绑定',
          targetId,
        );
      },
    );
  }

  /** 管理员发起密码重置，收件人设置新密码后才改变账户。 */
  async requestPasswordReset(actorId: string, targetId: string): Promise<VerificationResponse> {
    const user = await this.requireUser(this.options.store, targetId);
    if (user.status !== 'active')
      throw new AccountServiceError('invalid_user_status', '只有正常账户可重置密码');
    return this.requestChallenge(
      { email: user.email, purpose: 'reset', userId: user.id, payload: {} },
      async (store) => {
        await this.audit(
          store,
          'account.password.reset.request',
          actorId,
          targetId,
          '管理员发起邮件密码重置',
          targetId,
        );
      },
    );
  }

  /** 创建验证码并先持久化挑战及投递记录，发送失败保留可重发的账户。 */
  private async requestChallenge(
    input: Pick<EmailChallengeRecord, 'email' | 'purpose' | 'payload' | 'userId'>,
    beforeSave: (store: AuthStore, challenge: EmailChallengeRecord) => Promise<void>,
  ): Promise<VerificationResponse> {
    this.requireMail();
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const createdAt = new Date(this.now());
    const challenge: EmailChallengeRecord = {
      ...input,
      id: randomUUID(),
      codeHash: this.codeHash(input.email, input.purpose, code),
      attempts: 0,
      createdAt,
      expiresAt: new Date(this.now() + 10 * 60_000),
    };
    const delivery: EmailDeliveryRecord = {
      id: randomUUID(),
      to: input.email,
      purpose: input.purpose,
      status: 'pending',
      createdAt,
      updatedAt: createdAt,
    };
    await this.options.store.transaction(async (store) => {
      const previous = await store.findChallenge(input.email, input.purpose);
      if (previous && this.now() - previous.createdAt.getTime() < 60_000)
        throw new AccountServiceError(
          'verification_rate_limited',
          '请在 60 秒后重新发送验证码',
          429,
        );
      await beforeSave(store, challenge);
      if (challenge.userId)
        await store.invalidateChallenges(challenge.userId, new Date(this.now()), challenge.purpose);
      await store.saveChallenge(challenge);
      await store.saveDelivery(delivery);
    });
    try {
      await this.options.mail.send({ to: input.email, code, purpose: input.purpose });
      delivery.status = 'accepted';
    } catch {
      delivery.status = 'failed';
      delivery.error = 'SMTP 未确认接收，请检查邮件服务配置后重新发送';
    }
    delivery.updatedAt = new Date(this.now());
    await this.options.store.saveDelivery(delivery);
    return {
      verificationRequired: true,
      email: input.email,
      delivery: { id: delivery.id, status: delivery.status },
    };
  }

  /** 将六码和用途绑定到服务端密钥，避免数据库泄漏后离线枚举验证码。 */
  private codeHash(email: string, purpose: string, code: string): string {
    return createHmac('sha256', this.options.secret)
      .update(`${email}\0${purpose}\0${code}`)
      .digest('hex');
  }
  /** 明确拒绝未配置邮件服务的创建流程，不回退为免验证。 */
  private requireMail(): void {
    if (!this.options.mail.configured)
      throw new AccountServiceError(
        'email_not_configured',
        '邮件服务尚未配置，请先配置服务端 EMAIL_HOST、EMAIL_PORT、EMAIL_USER、EMAIL_PASS 和 EMAIL_FROM',
        503,
      );
  }
  /** 查询内部用户并以稳定 404 返回不存在的管理对象。 */
  private async requireUser(store: AuthStore, id: string): Promise<AuthUserRecord> {
    const user = await store.findUserById(id);
    if (!user) throw new AccountServiceError('user_not_found', '用户不存在', 404);
    return user;
  }
  /** 审计与用户修改共享事务，不记录任何敏感字段原值。 */
  private async audit(
    store: AuthStore,
    action: string,
    actorId: string,
    targetId: string,
    summary: string,
    ownerId?: string,
  ): Promise<void> {
    await store.appendAudit({
      id: randomUUID(),
      actorId,
      targetId,
      ownerId,
      action,
      summary,
      createdAt: new Date(this.now()),
    });
  }
}

/** 比较挑战哈希或部署凭据，避免长度一致时泄露内容前缀。 */
function constantEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 将可识别的账户异常映射为公开 HTTP 错误，未知异常交给统一错误边界。 */
export function accountError(
  error: unknown,
): { status: number; body: { code: string; error: string } } | undefined {
  if (error instanceof AccountServiceError)
    return { status: error.statusCode, body: { code: error.code, error: error.message } };
  if (error instanceof AuthServiceError || error instanceof AuthStoreError)
    return {
      status: error.code === 'email_taken' ? 409 : 400,
      body: { code: error.code, error: error.message },
    };
  return undefined;
}
