import { BlockList, isIP } from 'node:net';

/** Compose 内网代理地址范围；API 必须保持不发布宿主端口。 */
const proxyPeers = new BlockList();
proxyPeers.addSubnet('10.0.0.0', 8, 'ipv4');
proxyPeers.addSubnet('172.16.0.0', 12, 'ipv4');
proxyPeers.addSubnet('192.168.0.0', 16, 'ipv4');
proxyPeers.addSubnet('fc00::', 7, 'ipv6');

/** 判断直接连接是否来自 Compose 私有网络；不信任第二跳、公网或无效地址。 */
function trustPrivateProxy(address: string, hop: number): boolean {
  const version = isIP(address);
  return hop === 0 && version !== 0 && proxyPeers.check(address, version === 6 ? 'ipv6' : 'ipv4');
}

/**
 * 解析 API 前方可信代理跳数；默认不信任转发头，仅允许私有网络中的直接代理。
 * @param value API_TRUST_PROXY_HOPS 原值；允许未设置、0 或 1。
 * @returns Fastify trustProxy 回调；1 仅用于 API 不发布宿主端口的专用 Compose 网络。
 * @throws 配置为空、布尔值或大于一跳时拒绝启动，防止无界信任客户端转发头。
 */
export function resolveApiProxyTrust(
  value: string | undefined,
): false | ((address: string, hop: number) => boolean) {
  if (value === undefined || value === '0') return false;
  if (value === '1') return trustPrivateProxy;
  throw new Error('API_TRUST_PROXY_HOPS must be "0" or "1"');
}
