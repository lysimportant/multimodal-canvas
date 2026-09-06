import type { FastifyInstance } from 'fastify';
import type { AccountMailSender } from '../account-mail';

/** 隔离邮件替身只保存合成测试中的验证码，从不连接 SMTP。 */
export class TestAccountMailSender implements AccountMailSender {
  configured = true;
  publicConfiguration = {
    host: 'smtp.example.test',
    port: 465,
    secure: true,
    from: 'no-reply@example.test',
  };
  messages: { to: string; code: string; purpose: string }[] = [];
  fail = false;
  /** 可显式模拟 SMTP 拒绝，敏感错误内容不得泄露到响应或投递记录。 */
  async send(input: { to: string; code: string; purpose: string }): Promise<void> {
    if (this.fail) throw new Error('synthetic-secret-must-not-leak');
    this.messages.push(input);
  }
  /** 返回指定合成邮箱和用途的最近邮件。 */
  latest(email: string, purpose: string) {
    return [...this.messages]
      .reverse()
      .find((message) => message.to === email.toLowerCase() && message.purpose === purpose)!;
  }
}

/** 既有业务回归通过真实注册和验证路由建立用户，不绕过新增邮箱验证。 */
export async function registerVerifiedTestUser(
  app: FastifyInstance,
  mail: TestAccountMailSender,
  input: { email: string; password: string; displayName?: string },
) {
  const registration = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: input,
  });
  if (registration.statusCode !== 202) throw new Error(`Registration failed: ${registration.body}`);
  return app.inject({
    method: 'POST',
    url: '/v1/auth/verify',
    payload: {
      email: input.email,
      code: mail.latest(input.email, 'register').code,
      purpose: 'register',
    },
  });
}
