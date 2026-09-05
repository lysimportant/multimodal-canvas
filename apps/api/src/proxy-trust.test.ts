import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { resolveApiProxyTrust } from './proxy-trust';

describe('API 受限代理信任', () => {
  it('默认及显式 0 不信任代理', () => {
    expect(resolveApiProxyTrust(undefined)).toBe(false);
    expect(resolveApiProxyTrust('0')).toBe(false);
    expect(resolveApiProxyTrust('1')).toBeTypeOf('function');
  });

  it.each(['', 'true', 'false', '2', '-1', '1.0', ' 1', '*'])('拒绝无界或含糊配置 %j', (value) => {
    expect(() => resolveApiProxyTrust(value)).toThrow('API_TRUST_PROXY_HOPS');
  });

  it('默认忽略伪造的转发头', async () => {
    const app = Fastify({ trustProxy: resolveApiProxyTrust(undefined) });
    app.get('/ip', (request) => ({ ip: request.ip }));
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/ip',
        remoteAddress: '172.25.0.7',
        headers: { 'x-forwarded-for': '203.0.113.99' },
      });
      expect(response.json()).toEqual({ ip: '172.25.0.7' });
    } finally {
      await app.close();
    }
  });

  it.each(['198.51.100.5', '2001:db8::1', '127.0.0.1', '::1'])(
    '拒绝非 Compose 对端 %s 的转发头',
    async (remoteAddress) => {
      const app = Fastify({ trustProxy: resolveApiProxyTrust('1') });
      app.get('/ip', (request) => ({ ip: request.ip, protocol: request.protocol }));
      try {
        const response = await app.inject({
          method: 'GET',
          url: '/ip',
          remoteAddress,
          headers: { 'x-forwarded-for': '203.0.113.99', 'x-forwarded-proto': 'https' },
        });
        expect(response.json()).toEqual({ ip: remoteAddress, protocol: 'http' });
      } finally {
        await app.close();
      }
    },
  );

  it.each(['10.2.3.4', '172.25.0.7', '192.168.5.4', 'fd00::5', '::ffff:172.25.0.7'])(
    '只信任私有地址 %s 的第一跳',
    (address) => {
      const trust = resolveApiProxyTrust('1');
      if (trust === false) throw new Error('Expected proxy trust callback');
      expect(trust(address, 0)).toBe(true);
      expect(trust(address, 1)).toBe(false);
      expect(trust('invalid-ip', 0)).toBe(false);
    },
  );

  it('仅读取最近代理写入的地址，不信任其左侧的客户端伪造链', async () => {
    const app = Fastify({ trustProxy: resolveApiProxyTrust('1') });
    app.get('/ip', (request) => ({ ip: request.ip, protocol: request.protocol }));
    try {
      for (const client of ['198.51.100.10', '198.51.100.11']) {
        const response = await app.inject({
          method: 'GET',
          url: '/ip',
          remoteAddress: '172.25.0.7',
          headers: { 'x-forwarded-for': `203.0.113.99, ${client}`, 'x-forwarded-proto': 'https' },
        });
        expect(response.json()).toEqual({ ip: client, protocol: 'https' });
      }
    } finally {
      await app.close();
    }
  });
});
