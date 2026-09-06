import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAccountMailSender } from './account-mail';

/** 替代网络层，配置测试不连接真实 SMTP 或本机代理。 */
const smtp = vi.hoisted(() => ({ sendMail: vi.fn(), createTransport: vi.fn() }));
vi.mock('nodemailer', () => ({ default: { createTransport: smtp.createTransport } }));
afterEach(() => vi.clearAllMocks());

describe('邮件配置与安全投递', () => {
  it('采用受控 EMAIL_* 配置和可选代理但不暴露认证或代理信息', async () => {
    smtp.sendMail.mockResolvedValue({ accepted: ['owner@example.test'] });
    smtp.createTransport.mockReturnValue({ sendMail: smtp.sendMail });
    const mail = createAccountMailSender({
      EMAIL_HOST: 'smtp.example.test',
      EMAIL_PORT: '465',
      EMAIL_SECURE: 'true',
      EMAIL_USER: 'synthetic-user',
      EMAIL_PASS: 'synthetic-password',
      EMAIL_FROM: 'no-reply@example.test',
      EMAIL_PROXY: 'http://synthetic:proxy-password@127.0.0.1:15732',
      APP_PUBLIC_URL: 'https://canvas.example.test',
    });
    expect(mail.configured).toBe(true);
    expect(JSON.stringify(mail.publicConfiguration)).not.toContain('password');
    expect(JSON.stringify(mail.publicConfiguration)).not.toContain('15732');
    expect(smtp.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        secure: true,
        logger: false,
        debug: false,
        proxy: 'http://synthetic:proxy-password@127.0.0.1:15732',
      }),
    );
    await mail.send({ to: 'owner@example.test', code: '123456', purpose: 'invite' });
    expect(smtp.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'owner@example.test',
        text: expect.stringContaining('/auth/verify?email=owner%40example.test&purpose=invite'),
      }),
    );
  });
  it('STARTTLS 模式强制 TLS，缺配置与服务器未接收均明确失败', async () => {
    smtp.sendMail.mockResolvedValue({ accepted: [] });
    smtp.createTransport.mockReturnValue({ sendMail: smtp.sendMail });
    const mail = createAccountMailSender({
      EMAIL_HOST: 'smtp.example.test',
      EMAIL_PORT: '587',
      EMAIL_SECURE: 'false',
      EMAIL_USER: 'synthetic-user',
      EMAIL_PASS: 'synthetic-password',
      EMAIL_FROM: 'no-reply@example.test',
    });
    expect(smtp.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ secure: false, requireTLS: true }),
    );
    await expect(
      mail.send({ to: 'owner@example.test', code: '123456', purpose: 'register' }),
    ).rejects.toThrow('smtp_rejected');
    const missing = createAccountMailSender({});
    expect(missing.configured).toBe(false);
    await expect(
      missing.send({ to: 'owner@example.test', code: '123456', purpose: 'register' }),
    ).rejects.toThrow('email_not_configured');
  });
  it('无效代理协议在创建 SMTP 客户端前拒绝且错误不回显URL', () => {
    expect(() =>
      createAccountMailSender({ EMAIL_PROXY: 'ftp://private:password@example.test' }),
    ).toThrow('EMAIL_PROXY 必须是有效 HTTP 或 HTTPS 代理地址');
    expect(smtp.createTransport).not.toHaveBeenCalled();
  });
});
