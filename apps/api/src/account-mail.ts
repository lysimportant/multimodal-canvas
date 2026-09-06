import nodemailer from 'nodemailer';

/** 服务端邮件发送边界；测试注入替身，不会真实发送邮件。 */
export type AccountMailSender = {
  configured: boolean;
  publicConfiguration: { host?: string; port?: number; secure?: boolean; from?: string };
  send(input: { to: string; code: string; purpose: string }): Promise<void>;
};

/** 从受控环境创建 SMTP 发送器；缺配置时显式拒绝，配置不回传认证信息。 */
export function createAccountMailSender(
  environment: NodeJS.ProcessEnv = process.env,
): AccountMailSender {
  const host = environment.EMAIL_HOST ?? environment.EMAIL_SMTP_HOST;
  const port = Number(environment.EMAIL_PORT ?? environment.EMAIL_SMTP_PORT ?? 465);
  const secureValue = environment.EMAIL_SECURE ?? environment.EMAIL_SMTP_SECURE ?? 'true';
  const secure = secureValue === 'true';
  const user = environment.EMAIL_USER ?? environment.EMAIL_SMTP_USER;
  const pass = environment.EMAIL_PASS ?? environment.EMAIL_SMTP_PASSWORD;
  const from = environment.EMAIL_FROM ?? environment.EMAIL_SMTP_FROM;
  const proxy = environment.EMAIL_PROXY;
  if (proxy) {
    try {
      if (!['http:', 'https:'].includes(new URL(proxy).protocol)) throw new Error();
    } catch {
      throw new Error('EMAIL_PROXY 必须是有效 HTTP 或 HTTPS 代理地址');
    }
  }
  const configured = Boolean(
    host &&
    user &&
    pass &&
    from &&
    Number.isInteger(port) &&
    port > 0 &&
    port <= 65535 &&
    ['true', 'false'].includes(secureValue),
  );
  const transport = configured
    ? nodemailer.createTransport({
        host,
        port,
        secure,
        requireTLS: !secure,
        auth: { user, pass },
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 15_000,
        logger: false,
        debug: false,
        ...(proxy ? { proxy } : {}),
      })
    : undefined;
  return {
    configured,
    publicConfiguration: { ...(host ? { host } : {}), port, secure, ...(from ? { from } : {}) },
    async send(input) {
      if (!transport) throw new Error('email_not_configured');
      const publicUrl = environment.APP_PUBLIC_URL;
      let verificationUrl: string | undefined;
      if (publicUrl) {
        const candidate = new URL('/auth/verify', publicUrl);
        if (
          !['http:', 'https:'].includes(candidate.protocol) ||
          candidate.username ||
          candidate.password
        )
          throw new Error('invalid_public_url');
        candidate.searchParams.set('email', input.to);
        candidate.searchParams.set('purpose', input.purpose);
        verificationUrl = candidate.toString();
      }
      const result = await transport.sendMail({
        from,
        to: input.to,
        subject: 'Multimodal Canvas 邮箱验证',
        text: `你的验证码为：${input.code}\n验证码 10 分钟内有效，请勿向他人透露。\n${verificationUrl ? `验证页面：${verificationUrl}\n` : ''}如果并非本人操作，请忽略此邮件。`,
      });
      if (!result.accepted?.length) throw new Error('smtp_rejected');
    },
  };
}
